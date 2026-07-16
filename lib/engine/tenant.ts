import type { ChannelPlugin } from "@/channels/channel-plugin"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { LeucoSystemPromptBuilder } from "@/prompts/system-prompt-builder"
import { errorMessage } from "@/error-message"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import type { LeucoProjectStateStore } from "@/projects/project-state-store"

/**
 * Maximum wall-clock for a single codex turn. Approval-prompt deadlocks and
 * runaway tool loops are the two failure modes this guards against — the
 * daemon has no terminal so it can never answer a prompt, and without a cap
 * a stuck turn would block every subsequent message on the same project.
 *
 * On timeout the codex child is restarted (in-flight turn dies with it) and
 * the project thread is re-resumed on the next call.
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
  codexHome?: string
  timeZone?: string
  agentSpec?: TenantAgentSpec
  initialCodexThreadId?: string
  projectStateStore?: LeucoProjectStateStore
  codex: CodexClientPort
  plugins: ChannelPlugin[]
  useCommonInstructions?: boolean
  presets?: string[]
  /** `tenantConfigSignature(project)` at build time; reconcile compares it
   * against the freshly loaded project to decide whether to rebuild. */
  configSignature?: string
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
 * Owns one project: a single codex app-server child, the channel plugins
 * routed at it, and ONE codex thread shared across every channel, Slack
 * thread, and reaction. The project's conversation history is therefore
 * unified — channel plugins are still given a `threadKey` for their own
 * book-keeping, but the tenant ignores it for codex routing and serializes
 * every turn through the same chain.
 */
export class LeucoTenant {
  readonly projectId: string
  readonly projectName: string
  readonly projectPath: string
  readonly configSignature: string | null
  private readonly codexHome: string | null
  private readonly timeZone: string
  private readonly agentSpec: TenantAgentSpec
  private readonly codex: CodexClientPort
  private readonly plugins: ChannelPlugin[]
  private readonly log: Logger
  private readonly bus: LeucoEventBus
  private readonly projectStateStore: LeucoProjectStateStore | null
  private readonly useCommonInstructions: boolean
  private readonly presets: string[]
  private codexThreadId: string | null
  private codexThreadLive = false
  private pendingTurns: PendingTurn[] = []
  private turnInflight = false
  private stopped = false

  constructor(props: Props) {
    this.projectId = props.projectId
    this.projectName = props.projectName
    this.projectPath = props.projectPath
    this.configSignature = props.configSignature ?? null
    this.codexHome = props.codexHome ?? null
    this.timeZone = props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    this.agentSpec = props.agentSpec ?? {}
    this.codex = props.codex
    this.plugins = props.plugins
    this.log = props.onLog ?? ((line) => process.stdout.write(`${line}\n`))
    this.bus = props.bus ?? new LeucoEventBus()
    this.projectStateStore = props.projectStateStore ?? null
    this.useCommonInstructions = props.useCommonInstructions ?? true
    this.presets = props.presets ?? []
    this.codexThreadId = props.initialCodexThreadId ?? null
  }

  get key(): string {
    return this.projectName
  }

  isCodexRunning(): boolean {
    return this.codex.isRunning()
  }

  listPlugins(): string[] {
    return this.plugins.map((p) => p.name)
  }

  listThreads(): TenantThreadEntry[] {
    if (this.codexThreadId === null) return []
    return [{ threadKey: this.key, threadId: this.codexThreadId }]
  }

  clearThread(threadKey: string): boolean {
    if (threadKey !== this.key && threadKey !== this.codexThreadId) return false
    if (this.codexThreadId === null) return false
    this.codexThreadId = null
    this.codexThreadLive = false
    this.persistThread()
    return true
  }

  async start(): Promise<void> {
    this.stopped = false
    this.log(`[leuco] starting codex app-server for ${this.key}`)
    await this.codex.start()

    const started: ChannelPlugin[] = []
    try {
      for (const plugin of this.plugins) {
        this.log(`[leuco] starting plugin: ${plugin.name} → ${this.key}`)
        await plugin.start({
          cwd: this.projectPath,
          onLog: this.log,
          bus: this.bus,
          projectName: this.projectName,
          runTextTurn: (threadKey, text) => this.runTextTurn(threadKey, text),
        })
        started.push(plugin)
      }
    } catch (error) {
      for (const plugin of started.reverse()) {
        await plugin.stop().catch((err: unknown) => {
          this.log(`[leuco] start rollback: plugin ${plugin.name} stop: ${errorMessage(err)}`)
        })
      }
      await this.codex.stop().catch((err: unknown) => {
        this.log(`[leuco] start rollback: codex stop: ${errorMessage(err)}`)
      })
      throw error
    }

    this.bus.emit({
      ts: Date.now(),
      type: "tenant.started",
      project: this.projectName,
    })
  }

  async stop(): Promise<void> {
    // Must be set before codex.stop(): the drain loop otherwise takes the
    // next queued batch after the in-flight turn dies, sees the codex child
    // gone, and ensureThread re-spawns it — an orphan codex process nobody
    // owns after this tenant is discarded (reconcile rebuilds, shutdown).
    this.stopped = true

    // Begin closing every ingress first, but do not wait for a plugin whose
    // in-flight handler is itself waiting on codex. Stopping codex settles
    // those turns, after which the plugin shutdown promises can finish.
    const pluginStops = this.plugins.map(async (plugin) => {
      try {
        await plugin.stop()
      } catch (err) {
        this.log(`[leuco] plugin ${plugin.name} stop: ${errorMessage(err)}`)
      }
    })

    await this.codex.stop().catch((err: unknown) => {
      this.log(`[leuco] codex stop (${this.key}): ${errorMessage(err)}`)
    })

    await Promise.all(pluginStops)

    const abandoned = this.pendingTurns.splice(0)
    for (const pending of abandoned) {
      pending.resolve(new Error(`tenant ${this.key} stopped before the turn ran`))
    }

    this.bus.emit({
      ts: Date.now(),
      type: "tenant.stopped",
      project: this.projectName,
    })
  }

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

        if (this.stopped) {
          for (const pending of batch) {
            pending.resolve(new Error(`tenant ${this.key} stopped before the turn ran`))
          }
          continue
        }

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
    const combinedText = batch.length === 1 ? batch[0]!.text : batch.map((t) => t.text).join("\n\n")

    const threadIdOrError = await this.ensureThread()
    if (threadIdOrError instanceof Error) {
      this.bus.emit({
        ts: Date.now(),
        type: "turn.error",
        project: this.projectName,
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
      threadKey: primaryThreadKey,
      input: combinedText,
    })

    const reply = await this.runTextTurnWithTimeout(threadId, combinedText)
    if (reply instanceof Error) {
      this.bus.emit({
        ts: Date.now(),
        type: "turn.error",
        project: this.projectName,
        threadKey: primaryThreadKey,
        error: reply.message,
      })
      return reply
    }

    this.bus.emit({
      ts: Date.now(),
      type: "turn.complete",
      project: this.projectName,
      threadKey: primaryThreadKey,
      reply,
    })
    return reply
  }

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

    if (reply instanceof Error && isRestartableTurnError(reply)) {
      this.log(`[leuco] ${this.key}: ${reply.message}; restarting codex child`)
      this.codexThreadLive = false
      await this.codex.stop().catch(() => undefined)
      if (!this.stopped) {
        await this.codex.start().catch((err: unknown) => {
          this.log(`[leuco] ${this.key}: codex restart after timeout failed: ${errorMessage(err)}`)
        })
      }
    }

    return reply
  }

  private async ensureThread(): Promise<string | Error> {
    if (this.stopped) {
      return new Error(`tenant ${this.key} is stopped`)
    }

    // If the codex child died (SIGSEGV / OOM / external kill / `app-server`
    // exited cleanly) we surface a fresh respawn here instead of letting
    // every subsequent turn fail with `codex client not started`. The
    // persisted thread id survives, so the next ensureThread call will
    // `resumeThread` it.
    if (!this.codex.isRunning()) {
      this.log(`[leuco] ${this.key}: codex child not running — respawning`)
      this.codexThreadLive = false
      const restart = await this.codex.start().catch((err: unknown) => err)
      if (restart instanceof Error) {
        return new Error(`codex respawn failed: ${errorMessage(restart)}`)
      }
      this.bus.emit({
        ts: Date.now(),
        type: "log",
        level: "warn",
        line: `[${this.key}] codex child respawned after exit`,
      })
    }

    if (this.codexThreadId !== null && this.codexThreadLive) return this.codexThreadId

    const developerInstructions = this.composeDeveloperInstructions()

    if (this.codexThreadId !== null) {
      const resumed = await this.codex.resumeThread({
        threadId: this.codexThreadId,
        cwd: this.projectPath,
        developerInstructions,
      })
      if (resumed instanceof Error) return resumed
      if (resumed !== null) {
        this.log(`[leuco] resumed codex thread ${this.codexThreadId} for ${this.key}`)
        this.codexThreadLive = true
        return resumed.thread.id
      }
      this.log(
        `[leuco] thread ${this.codexThreadId} not found in codex sqlite; starting a new thread`,
      )
      this.codexThreadId = null
    }

    const result = await this.codex.startThread({
      cwd: this.projectPath,
      developerInstructions,
      model: this.agentSpec.model,
    })
    if (result instanceof Error) return result
    this.codexThreadId = result.thread.id
    this.codexThreadLive = true
    this.persistThread()
    this.log(`[leuco] started codex thread ${this.codexThreadId} for ${this.key}`)
    return this.codexThreadId
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
      codexHome: this.codexHome,
      timeZone: this.timeZone,
      identities: this.plugins.map((p) => p.getIdentity()),
      presets: this.presets,
      perAgentInstructions: tail,
      usePreamble: this.useCommonInstructions,
    })
    return builder.build()
  }

  private persistThread(): void {
    const store = this.projectStateStore
    if (!store) return
    try {
      store.setCodexThreadId(this.projectId, this.codexThreadId)
    } catch (err) {
      this.log(`[leuco] failed to persist thread: ${errorMessage(err)}`)
    }
  }
}

const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

const isRestartableTurnError = (error: Error): boolean => {
  return (
    error.message.startsWith("codex turn timed out") ||
    error.message.startsWith("codex command output exceeded")
  )
}
