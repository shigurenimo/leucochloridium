import type { ChannelPlugin } from "@/engine/channel-plugin"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { LeucoSystemPromptBuilder, type SubagentEntry } from "@/engine/system-prompt-builder"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import type { LeucoProjectStore } from "@/projects/project-store"

type Logger = (line: string) => void

export type TenantAgentSpec = {
  developerInstructions?: string
  model?: string
}

type Props = {
  projectName: string
  projectPath: string
  agentName: string
  agentSpec?: TenantAgentSpec
  /** Codex thread id loaded from settings.json, or undefined if the agent has never run yet. */
  initialCodexThreadId?: string
  /** Used to persist a new codex thread id back into settings.json. Optional in tests. */
  projectStore?: LeucoProjectStore
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

/**
 * Owns one (project, agent) pair: a single codex app-server child, the channel
 * plugins routed at it, and ONE codex thread shared across every channel,
 * Slack thread, and reaction. The agent's conversation history is therefore
 * unified — channel plugins are still given a `threadKey` for their own
 * book-keeping, but the tenant ignores it for codex routing and serializes
 * every turn through the same chain.
 *
 * Codex thread id persistence rides on the project's `settings.json` via
 * `LeucoProjectStore.setAgentThreadId()`; there is no separate thread.json.
 */
export class LeucoTenant {
  readonly projectName: string
  readonly projectPath: string
  readonly agentName: string
  private readonly agentSpec: TenantAgentSpec
  private readonly codex: CodexClientPort
  private readonly plugins: ChannelPlugin[]
  private readonly log: Logger
  private readonly bus: LeucoEventBus
  private readonly projectStore: LeucoProjectStore | null
  private readonly useCommonInstructions: boolean
  private readonly listSubagents: () => SubagentEntry[]
  private readonly presets: string[]
  private agentThreadId: string | null
  /** True once the agent thread is loaded into the running codex app-server. */
  private agentThreadLive = false
  /** Single chain — all turns serialize through one codex thread. */
  private turnChain: Promise<string> = Promise.resolve("")

  constructor(props: Props) {
    this.projectName = props.projectName
    this.projectPath = props.projectPath
    this.agentName = props.agentName
    this.agentSpec = props.agentSpec ?? {}
    this.codex = props.codex
    this.plugins = props.plugins
    this.log = props.onLog ?? ((line) => process.stdout.write(`${line}\n`))
    this.bus = props.bus ?? new LeucoEventBus()
    this.projectStore = props.projectStore ?? null
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
   * Queue a text turn. `threadKey` is propagated to the bus so consumers can
   * still see which Slack thread / channel triggered the turn, but every turn
   * runs through the agent's single codex thread (serialized).
   */
  runTextTurn(threadKey: string, text: string): Promise<string> {
    const next = this.turnChain
      .catch(() => "")
      .then(async () => {
        const threadId = await this.ensureAgentThread()
        this.log(`[leuco] turn → ${threadId} (${truncate(text, 60)})`)
        this.bus.emit({
          ts: Date.now(),
          type: "turn.start",
          project: this.projectName,
          agent: this.agentName,
          threadKey,
          input: text,
        })
        try {
          const reply = await this.codex.runTextTurn(threadId, text, this.projectPath)
          this.bus.emit({
            ts: Date.now(),
            type: "turn.complete",
            project: this.projectName,
            agent: this.agentName,
            threadKey,
            reply,
          })
          return reply
        } catch (err) {
          this.bus.emit({
            ts: Date.now(),
            type: "turn.error",
            project: this.projectName,
            agent: this.agentName,
            threadKey,
            error: errorText(err),
          })
          throw err
        }
      })

    this.turnChain = next
    return next
  }

  private async ensureAgentThread(): Promise<string> {
    if (this.agentThreadId !== null && this.agentThreadLive) return this.agentThreadId

    const developerInstructions = this.composeDeveloperInstructions()

    if (this.agentThreadId !== null) {
      const resumed = await this.codex.resumeThread({
        threadId: this.agentThreadId,
        cwd: this.projectPath,
        developerInstructions,
        excludeTurns: true,
      })
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
    const store = this.projectStore
    if (!store) return
    const result = store.setAgentThreadId(this.projectName, this.agentName, this.agentThreadId)
    if (result instanceof Error) {
      this.log(`[leuco] failed to persist agent thread: ${result.message}`)
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
