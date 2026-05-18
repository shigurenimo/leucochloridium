import type { ChannelPlugin } from "@/engine/channel-plugin"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { LeucoSystemPromptBuilder, type SubagentEntry } from "@/engine/system-prompt-builder"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import type { LeucoAgentStateStore } from "@/projects/agent-state-store"

/**
 * Maximum wall-clock for a single codex turn. Approval-prompt deadlocks and
 * runaway tool loops are the two failure modes this guards against — the
 * daemon has no terminal so it can never answer a prompt, and without a cap
 * a stuck turn would block every subsequent message on the same agent.
 *
 * On timeout the codex child is restarted (in-flight turn dies with it) and
 * the agent thread is re-resumed on the next call.
 */
const TURN_TIMEOUT_MS = 10 * 60 * 1000

type Logger = (line: string) => void

export type TenantAgentSpec = {
  developerInstructions?: string
  model?: string
}

type Props = {
  projectId: string
  projectName: string
  projectPath: string
  agentName: string
  agentSpec?: TenantAgentSpec
  /** Codex thread id loaded from state.json, or undefined if the agent has never run yet. */
  initialCodexThreadId?: string
  /** Used to persist a new codex thread id into agents/<a>/state.json. Optional in tests. */
  agentStateStore?: LeucoAgentStateStore
  codex: CodexClientPort
  plugins: ChannelPlugin[]
  /**
   * When true (default), prepend the dynamic leuco preamble (bot identity,
   * loop avoidance, sub-agent paths) to the agent's developer instructions.
   * When false, only `agentSpec.developerInstructions` is sent through.
   */
  useCommonInstructions?: boolean
  /**
   * Called every time a turn starts to gather the current list of project
   * sub-agents. Injected so tests can provide a deterministic list without
   * touching the filesystem. Result is folded into the dynamic preamble.
   */
  listSubagents?: () => SubagentEntry[]
  /**
   * Pre-resolved preset bodies (already looked up from
   * `LeucoPromptPresets`). Spliced in between the dynamic preamble and the
   * per-agent TOML text on every turn.
   */
  presets?: string[]
  onLog?: Logger
  bus?: LeucoEventBus
}

export type TenantThreadEntry = {
  threadKey: string
  threadId: string
}

type PendingTurn = {
  threadKey: string
  text: string
  resolve: (reply: string | Error) => void
}

/**
 * Owns one (project, agent) pair: a single codex app-server child, the channel
 * plugins routed at it, and ONE codex thread shared across every channel,
 * Slack thread, and reaction. The agent's conversation history is therefore
 * unified — channel plugins are still given a `threadKey` for their own
 * book-keeping, but the tenant ignores it for codex routing and serializes
 * every turn through the same chain.
 *
 * Codex thread id persistence rides on a separate per-agent state file
 * (`agents/<a>/state.json`) written through `LeucoAgentStateStore` so the
 * user-edited `settings.json` is never touched by the daemon.
 */
export class LeucoTenant {
  readonly projectId: string
  readonly projectName: string
  readonly projectPath: string
  readonly agentName: string
  private readonly agentSpec: TenantAgentSpec
  private readonly codex: CodexClientPort
  private readonly plugins: ChannelPlugin[]
  private readonly log: Logger
  private readonly bus: LeucoEventBus
  private readonly agentStateStore: LeucoAgentStateStore | null
  private readonly useCommonInstructions: boolean
  private readonly listSubagents: () => SubagentEntry[]
  private readonly presets: string[]
  private agentThreadId: string | null
  /** True once the agent thread is loaded into the running codex app-server. */
  private agentThreadLive = false
  /**
   * Pending text turns from every channel. While one batch is running, new
   * arrivals queue here; once the current turn finishes, everything in the
   * queue is merged into the next batch (separator: blank line). This is the
   * "true end-of-turn queue" behaviour the upstream Claude Code feature
   * request asks for — codex never sees a half-finished turn interrupted.
   */
  private pendingTurns: PendingTurn[] = []
  private turnInflight = false

  constructor(props: Props) {
    this.projectId = props.projectId
    this.projectName = props.projectName
    this.projectPath = props.projectPath
    this.agentName = props.agentName
    this.agentSpec = props.agentSpec ?? {}
    this.codex = props.codex
    this.plugins = props.plugins
    this.log = props.onLog ?? ((line) => process.stdout.write(`${line}\n`))
    this.bus = props.bus ?? new LeucoEventBus()
    this.agentStateStore = props.agentStateStore ?? null
    this.useCommonInstructions = props.useCommonInstructions ?? true
    this.listSubagents = props.listSubagents ?? (() => [])
    this.presets = props.presets ?? []
    this.agentThreadId = props.initialCodexThreadId ?? null
  }

  get key(): string {
    return `${this.projectName}:${this.agentName}`
  }

  isCodexRunning(): boolean {
    return this.codex.isRunning()
  }

  listPlugins(): string[] {
    return this.plugins.map((p) => p.name)
  }

  listThreads(): TenantThreadEntry[] {
    if (this.agentThreadId === null) return []
    return [{ threadKey: this.key, threadId: this.agentThreadId }]
  }

  /** Drop the persisted agent thread so the next turn starts fresh. */
  clearThread(threadKey: string): boolean {
    if (threadKey !== this.key && threadKey !== this.agentThreadId) return false
    if (this.agentThreadId === null) return false
    this.agentThreadId = null
    this.agentThreadLive = false
    this.persistAgentThread()
    return true
  }

  async start(): Promise<void> {
    this.log(`[leuco] starting codex app-server for ${this.key}`)
    await this.codex.start()

    for (const plugin of this.plugins) {
      this.log(`[leuco] starting plugin: ${plugin.name} → ${this.key}`)
      await plugin.start({
        cwd: this.projectPath,
        onLog: this.log,
        bus: this.bus,
        projectName: this.projectName,
        agentName: this.agentName,
        runTextTurn: (threadKey, text) => this.runTextTurn(threadKey, text),
      })
    }

    this.bus.emit({
      ts: Date.now(),
      type: "tenant.started",
      project: this.projectName,
      agent: this.agentName,
    })
  }

  async stop(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.stop().catch((err: unknown) => {
        this.log(`[leuco] plugin ${plugin.name} stop: ${errorText(err)}`)
      })
    }

    await this.codex.stop().catch((err: unknown) => {
      this.log(`[leuco] codex stop (${this.key}): ${errorText(err)}`)
    })

    this.bus.emit({
      ts: Date.now(),
      type: "tenant.stopped",
      project: this.projectName,
      agent: this.agentName,
    })
  }

  /**
   * Queue a text turn. While a turn is running, additional calls collect in
   * `pendingTurns` and are merged into a single follow-up turn once the
   * current one finishes — so a Slack thread that bursts three messages
   * during a long codex run produces ONE next-turn instead of three queued
   * ones. Each caller's awaited promise resolves with the same merged reply.
   *
   * `threadKey` is propagated to the bus event for the first message in a
   * batch so consumers can still see which Slack thread / channel kicked
   * the turn off; merged inputs share that event id.
   */
  runTextTurn(threadKey: string, text: string): Promise<string | Error> {
    return new Promise<string | Error>((resolve) => {
      this.pendingTurns.push({ threadKey, text, resolve })
      void this.drainTurns()
    })
  }

  private async drainTurns(): Promise<void> {
    if (this.turnInflight) return
    this.turnInflight = true
    try {
      while (this.pendingTurns.length > 0) {
        const batch = this.pendingTurns.splice(0)
        const reply = await this.executeBatchedTurn(batch).catch((err: unknown) =>
          err instanceof Error ? err : new Error(String(err)),
        )
        for (const pending of batch) pending.resolve(reply)
      }
    } finally {
      this.turnInflight = false
    }
  }

  private async executeBatchedTurn(batch: PendingTurn[]): Promise<string | Error> {
    const primaryThreadKey = batch[0]!.threadKey
    const combinedText =
      batch.length === 1 ? batch[0]!.text : batch.map((t) => t.text).join("\n\n")

    const threadIdOrError = await this.ensureAgentThread()
    if (threadIdOrError instanceof Error) {
      this.bus.emit({
        ts: Date.now(),
        type: "turn.error",
        project: this.projectName,
        agent: this.agentName,
        threadKey: primaryThreadKey,
        error: threadIdOrError.message,
      })
      return threadIdOrError
    }
    const threadId = threadIdOrError

    this.log(
      batch.length === 1
        ? `[leuco] turn → ${threadId} (${truncate(combinedText, 60)})`
        : `[leuco] turn ×${batch.length} → ${threadId} (${truncate(combinedText, 60)})`,
    )
    this.bus.emit({
      ts: Date.now(),
      type: "turn.start",
      project: this.projectName,
      agent: this.agentName,
      threadKey: primaryThreadKey,
      input: combinedText,
    })

    const reply = await this.runTextTurnWithTimeout(threadId, combinedText)
    if (reply instanceof Error) {
      this.bus.emit({
        ts: Date.now(),
        type: "turn.error",
        project: this.projectName,
        agent: this.agentName,
        threadKey: primaryThreadKey,
        error: reply.message,
      })
      return reply
    }

    this.bus.emit({
      ts: Date.now(),
      type: "turn.complete",
      project: this.projectName,
      agent: this.agentName,
      threadKey: primaryThreadKey,
      reply,
    })
    return reply
  }

  /**
   * Race the codex turn against a wall-clock deadline. On timeout, restart
   * the codex child so the abandoned turn (still running on the app-server)
   * can't collide with the next request — abortInFlightTurns inside the
   * client rejects the racing Promise once the child exits, and the agent
   * thread is marked stale so the next call re-resumes from sqlite.
   */
  private async runTextTurnWithTimeout(threadId: string, text: string): Promise<string | Error> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<Error>((resolve) => {
      timer = setTimeout(() => {
        resolve(new Error(`codex turn timed out after ${TURN_TIMEOUT_MS / 1000}s`))
      }, TURN_TIMEOUT_MS)
    })

    const replyPromise = this.codex.runTextTurn(threadId, text, this.projectPath)
    const reply = await Promise.race([replyPromise, timeoutPromise])
    if (timer) clearTimeout(timer)

    const timedOut = reply instanceof Error && reply.message.startsWith("codex turn timed out")
    if (timedOut) {
      this.log(`[leuco] ${this.key}: ${(reply as Error).message}; restarting codex child`)
      this.agentThreadLive = false
      await this.codex.stop().catch(() => undefined)
      await this.codex.start().catch((err: unknown) => {
        this.log(`[leuco] ${this.key}: codex restart after timeout failed: ${errorText(err)}`)
      })
    }

    return reply
  }

  private async ensureAgentThread(): Promise<string | Error> {
    if (this.agentThreadId !== null && this.agentThreadLive) return this.agentThreadId

    const developerInstructions = this.composeDeveloperInstructions()

    if (this.agentThreadId !== null) {
      const resumed = await this.codex.resumeThread({
        threadId: this.agentThreadId,
        cwd: this.projectPath,
        developerInstructions,
      })
      if (resumed instanceof Error) return resumed
      if (resumed !== null) {
        this.log(`[leuco] resumed codex thread ${this.agentThreadId} for ${this.key}`)
        this.agentThreadLive = true
        return resumed.thread.id
      }
      this.log(
        `[leuco] thread ${this.agentThreadId} not found in codex sqlite; starting a new agent thread`,
      )
      this.agentThreadId = null
    }

    const result = await this.codex.startThread({
      cwd: this.projectPath,
      developerInstructions,
      model: this.agentSpec.model,
    })
    if (result instanceof Error) return result
    this.agentThreadId = result.thread.id
    this.agentThreadLive = true
    this.persistAgentThread()
    this.log(`[leuco] started codex thread ${this.agentThreadId} for ${this.key}`)
    return this.agentThreadId
  }

  private composeDeveloperInstructions(): string | undefined {
    const tail = this.agentSpec.developerInstructions ?? null
    const hasPresets = this.presets.length > 0

    if (!this.useCommonInstructions && !hasPresets) {
      return tail ?? undefined
    }

    const builder = new LeucoSystemPromptBuilder({
      projectName: this.projectName,
      projectPath: this.projectPath,
      agentName: this.agentName,
      identities: this.plugins.map((p) => p.getIdentity()),
      subagents: this.listSubagents(),
      presets: this.presets,
      perAgentInstructions: tail,
      usePreamble: this.useCommonInstructions,
    })
    return builder.build()
  }

  private persistAgentThread(): void {
    const store = this.agentStateStore
    if (!store) return
    try {
      store.setCodexThreadId(this.projectId, this.agentName, this.agentThreadId)
    } catch (err) {
      this.log(`[leuco] failed to persist agent thread: ${errorText(err)}`)
    }
  }
}

const errorText = (err: unknown): string => {
  return err instanceof Error ? err.message : String(err)
}

const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}
