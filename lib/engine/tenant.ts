import type { ChannelPlugin } from "@/channels/channel-plugin"
import type { ConversationScope } from "@/config/config-schema"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { LeucoSystemPromptBuilder } from "@/prompts/system-prompt-builder"
import { errorMessage } from "@/error-message"
import {
  DEFAULT_TURN_IDLE_TIMEOUT_MS,
  DEFAULT_TURN_CONCURRENCY,
  DEFAULT_TURN_QUEUE_MAX_BYTES,
  DEFAULT_TURN_QUEUE_MAX_ITEMS,
  DEFAULT_TURN_TIMEOUT_MS,
} from "@/engine/turn-timeouts"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import type { LeucoProjectStateStore } from "@/projects/project-state-store"

export {
  DEFAULT_TURN_IDLE_TIMEOUT_MS,
  DEFAULT_TURN_CONCURRENCY,
  DEFAULT_TURN_QUEUE_MAX_BYTES,
  DEFAULT_TURN_QUEUE_MAX_ITEMS,
  DEFAULT_TURN_TIMEOUT_MS,
} from "@/engine/turn-timeouts"

/**
 * Maximum wall-clock for a single codex turn. Approval-prompt deadlocks and
 * runaway tool loops are the two failure modes this guards against — the
 * daemon has no terminal so it can never answer a prompt, and without a cap
 * a stuck turn would block every subsequent message on the same project.
 *
 * A separate no-notification timer catches stalled turns earlier. On either
 * timeout the codex child is restarted (the in-flight turn dies with it) and
 * the project thread is re-resumed on the next call.
 */
type Logger = (line: string) => void

type ProjectStateStorePort = Pick<LeucoProjectStateStore, "setCodexThreadId" | "setCodexThreadIds">

export type TenantAgentSpec = {
  developerInstructions?: string
  model?: string
}

export type LeucoTenantProps = {
  projectId: string
  projectName: string
  projectPath: string
  codexHome?: string
  timeZone?: string
  agentSpec?: TenantAgentSpec
  conversationScope?: ConversationScope
  initialCodexThreadId?: string
  initialCodexThreadIds?: Readonly<Record<string, string>>
  projectStateStore?: ProjectStateStorePort
  codex: CodexClientPort
  plugins: ChannelPlugin[]
  useCommonInstructions?: boolean
  presets?: string[]
  /** `tenantConfigSignature(project)` at build time; reconcile compares it
   * against the freshly loaded project to decide whether to rebuild. */
  configSignature?: string
  onLog?: Logger
  bus?: LeucoEventBus
  /** Hard wall-clock and no-notification limits. Overridable for tests. */
  turnTimeoutMs?: number
  turnIdleTimeoutMs?: number
  turnConcurrency?: number
  /** Pending-turn admission limits. Overridable for embedded runtimes and tests. */
  turnQueueMaxItems?: number
  turnQueueMaxBytes?: number
}

export type TenantThreadEntry = {
  threadKey: string
  threadId: string
}

type PendingTurn = {
  threadKey: string
  text: string
  enqueuedAt: number
  resolve: (reply: string | Error) => void
}

/**
 * Owns one project: a single codex app-server child and its channel plugins.
 * Conversation routing is configurable: project scope keeps one shared Codex
 * thread, while thread scope maps each plugin-provided threadKey to a separate
 * Codex thread. Turns remain ordered within one conversation key.
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
  private readonly projectStateStore: ProjectStateStorePort | null
  private readonly conversationScope: ConversationScope
  private readonly useCommonInstructions: boolean
  private readonly presets: string[]
  private readonly turnTimeoutMs: number
  private readonly turnIdleTimeoutMs: number
  private readonly turnConcurrency: number
  private readonly turnQueueMaxItems: number
  private readonly turnQueueMaxBytes: number
  private projectCodexThreadId: string | null
  private readonly threadCodexThreadIds: Map<string, string>
  private readonly liveCodexThreadIds = new Set<string>()
  private codexGeneration = 0
  private codexRecovery: Promise<void> | null = null
  private pendingTurns: PendingTurn[] = []
  private pendingTurnBytes = 0
  private readonly activeConversationKeys = new Set<string>()
  private activeTurnCount = 0
  private stopped = false

  constructor(props: LeucoTenantProps) {
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
    this.conversationScope = props.conversationScope ?? "project"
    this.useCommonInstructions = props.useCommonInstructions ?? true
    this.presets = props.presets ?? []
    this.turnTimeoutMs = props.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.turnIdleTimeoutMs = props.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS
    this.turnConcurrency = props.turnConcurrency ?? DEFAULT_TURN_CONCURRENCY
    this.turnQueueMaxItems = props.turnQueueMaxItems ?? DEFAULT_TURN_QUEUE_MAX_ITEMS
    this.turnQueueMaxBytes = props.turnQueueMaxBytes ?? DEFAULT_TURN_QUEUE_MAX_BYTES
    assertPositiveInteger("turnTimeoutMs", this.turnTimeoutMs)
    assertPositiveInteger("turnIdleTimeoutMs", this.turnIdleTimeoutMs)
    assertPositiveInteger("turnConcurrency", this.turnConcurrency)
    assertPositiveInteger("turnQueueMaxItems", this.turnQueueMaxItems)
    assertPositiveInteger("turnQueueMaxBytes", this.turnQueueMaxBytes)
    this.projectCodexThreadId = props.initialCodexThreadId ?? null
    this.threadCodexThreadIds = new Map(Object.entries(props.initialCodexThreadIds ?? {}))
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
    if (this.conversationScope === "project") {
      if (this.projectCodexThreadId === null) return []
      return [{ threadKey: this.key, threadId: this.projectCodexThreadId }]
    }
    return Array.from(this.threadCodexThreadIds, ([threadKey, threadId]) => ({
      threadKey,
      threadId,
    })).sort((a, b) => a.threadKey.localeCompare(b.threadKey))
  }

  clearThread(threadKey: string): boolean {
    if (this.conversationScope === "project") {
      if (threadKey !== this.key && threadKey !== this.projectCodexThreadId) return false
      if (this.projectCodexThreadId === null) return false
      this.liveCodexThreadIds.delete(this.projectCodexThreadId)
      this.projectCodexThreadId = null
      this.persistThreads()
      return true
    }

    const entry = Array.from(this.threadCodexThreadIds).find(
      (candidate) => candidate[0] === threadKey || candidate[1] === threadKey,
    )
    if (entry === undefined) return false
    this.threadCodexThreadIds.delete(entry[0])
    this.liveCodexThreadIds.delete(entry[1])
    this.persistThreads()
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
    // next queued turn after an in-flight turn dies, sees the codex child
    // gone, and ensureThread re-spawns it — an orphan codex process nobody
    // owns after this tenant is discarded (reconcile rebuilds, shutdown).
    this.stopped = true

    // Settle queued plugin handlers before waiting for plugin.stop(). A plugin
    // may wait for its accepted messages to finish, and stopped tenants will
    // no longer drain this queue.
    const abandoned = this.pendingTurns.splice(0)
    this.pendingTurnBytes = 0
    for (const pending of abandoned) {
      pending.resolve(new Error(`tenant ${this.key} stopped before the turn ran`))
    }

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

    this.bus.emit({
      ts: Date.now(),
      type: "tenant.stopped",
      project: this.projectName,
    })
  }

  runTextTurn(threadKey: string, text: string): Promise<string | Error> {
    return new Promise<string | Error>((resolve) => {
      if (this.stopped) {
        resolve(new Error(`tenant ${this.key} is stopped`))
        return
      }

      const inputBytes = Buffer.byteLength(text, "utf8")
      const queueDepth = this.pendingTurns.length + 1
      const queueBytes = this.pendingTurnBytes + inputBytes
      if (
        this.pendingTurns.length >= this.turnQueueMaxItems ||
        queueBytes > this.turnQueueMaxBytes
      ) {
        const reason =
          inputBytes > this.turnQueueMaxBytes
            ? `turn input exceeds ${this.turnQueueMaxBytes} byte limit`
            : `turn queue is full (pending=${this.pendingTurns.length}, bytes=${this.pendingTurnBytes})`
        const error = new Error(`tenant ${this.key} rejected turn: ${reason}`)
        this.log(`[leuco] ${this.key}: ${error.message}`)
        this.bus.emit({
          ts: Date.now(),
          type: "turn.rejected",
          project: this.projectName,
          threadKey,
          reason,
          queueDepth: this.pendingTurns.length,
          queueBytes: this.pendingTurnBytes,
          inputBytes,
        })
        resolve(error)
        return
      }

      const conversationKey = this.conversationKey(threadKey)
      const willQueue =
        this.pendingTurns.length > 0 ||
        this.activeTurnCount >= this.turnConcurrency ||
        this.activeConversationKeys.has(conversationKey)
      if (willQueue) {
        this.log(`[leuco] ${this.key}: turn queued (pending=${queueDepth})`)
        this.bus.emit({
          ts: Date.now(),
          type: "turn.queued",
          project: this.projectName,
          threadKey,
          queueDepth,
          queueBytes,
        })
      }
      this.pendingTurnBytes = queueBytes
      this.pendingTurns.push({ threadKey, text, enqueuedAt: Date.now(), resolve })
      this.drainTurns()
    })
  }

  private drainTurns(): void {
    if (this.stopped) return

    let index = 0
    while (this.activeTurnCount < this.turnConcurrency && index < this.pendingTurns.length) {
      const pending = this.pendingTurns[index]!
      const conversationKey = this.conversationKey(pending.threadKey)
      if (this.activeConversationKeys.has(conversationKey)) {
        index += 1
        continue
      }

      this.pendingTurns.splice(index, 1)
      this.pendingTurnBytes = Math.max(
        0,
        this.pendingTurnBytes - Buffer.byteLength(pending.text, "utf8"),
      )
      this.activeConversationKeys.add(conversationKey)
      this.activeTurnCount += 1

      void this.executeTurn(pending)
        .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
        .then((reply) => pending.resolve(reply))
        .finally(() => {
          this.activeConversationKeys.delete(conversationKey)
          this.activeTurnCount -= 1
          this.drainTurns()
        })
    }
  }

  private async executeTurn(pending: PendingTurn): Promise<string | Error> {
    const startedAt = Date.now()
    const deadlineAt = startedAt + this.turnTimeoutMs
    const queueWaitMs = Math.max(0, startedAt - pending.enqueuedAt)

    const threadIdOrError = await this.ensureThreadBefore(pending.threadKey, deadlineAt)
    if (threadIdOrError instanceof Error) {
      const durationMs = Date.now() - startedAt
      this.log(
        `[leuco] ${this.key}: turn failed before start (wait=${queueWaitMs}ms duration=${durationMs}ms): ${threadIdOrError.message}`,
      )
      this.bus.emit({
        ts: Date.now(),
        type: "turn.error",
        project: this.projectName,
        threadKey: pending.threadKey,
        error: threadIdOrError.message,
        durationMs,
        queueWaitMs,
      })
      return threadIdOrError
    }
    const threadId = threadIdOrError

    this.log(`[leuco] turn → ${threadId} wait=${queueWaitMs}ms (${truncate(pending.text, 60)})`)
    this.bus.emit({
      ts: Date.now(),
      type: "turn.start",
      project: this.projectName,
      threadKey: pending.threadKey,
      input: pending.text,
      batchSize: 1,
      queueWaitMs,
    })

    const hardTimeoutMs = Math.max(1, deadlineAt - Date.now())
    const reply = await this.runTextTurnWithTimeout(threadId, pending.text, hardTimeoutMs)
    const durationMs = Date.now() - startedAt
    if (reply instanceof Error) {
      this.log(
        `[leuco] ${this.key}: turn error duration=${durationMs}ms wait=${queueWaitMs}ms: ${reply.message}`,
      )
      this.bus.emit({
        ts: Date.now(),
        type: "turn.error",
        project: this.projectName,
        threadKey: pending.threadKey,
        error: reply.message,
        durationMs,
        queueWaitMs,
      })
      return reply
    }

    this.log(
      `[leuco] ${this.key}: turn complete duration=${durationMs}ms wait=${queueWaitMs}ms replyChars=${reply.length}`,
    )
    this.bus.emit({
      ts: Date.now(),
      type: "turn.complete",
      project: this.projectName,
      threadKey: pending.threadKey,
      reply,
      durationMs,
      queueWaitMs,
    })
    return reply
  }

  private async ensureThreadBefore(threadKey: string, deadlineAt: number): Promise<string | Error> {
    const remainingMs = Math.max(1, deadlineAt - Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<Error>((resolve) => {
      timer = setTimeout(() => {
        resolve(new Error(`codex turn timed out after ${this.turnTimeoutMs / 1000}s`))
      }, remainingMs)
    })

    const result = await Promise.race([this.ensureThread(threadKey), timeout])
    if (timer) clearTimeout(timer)
    if (result instanceof Error && isRestartableTurnError(result)) {
      await this.restartCodexChild(result.message)
    }
    return result
  }

  private async runTextTurnWithTimeout(
    threadId: string,
    text: string,
    hardTimeoutMs: number,
  ): Promise<string | Error> {
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let lastActivity = "turn/start"
    let resolveTimeout: ((error: Error) => void) | undefined
    let acceptingActivity = true

    const timeoutPromise = new Promise<Error>((resolve) => {
      resolveTimeout = resolve
      hardTimer = setTimeout(() => {
        resolve(new Error(`codex turn timed out after ${this.turnTimeoutMs / 1000}s`))
      }, hardTimeoutMs)
    })

    const resetIdleTimer = (method: string): void => {
      if (!acceptingActivity) return
      lastActivity = method
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        resolveTimeout?.(
          new Error(
            `codex turn idle timed out after ${this.turnIdleTimeoutMs / 1000}s without activity (last=${lastActivity})`,
          ),
        )
      }, this.turnIdleTimeoutMs)
    }
    resetIdleTimer(lastActivity)

    const replyPromise = this.codex
      .runTextTurn(threadId, text, this.projectPath, resetIdleTimer)
      .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
    const reply = await Promise.race([replyPromise, timeoutPromise])
    acceptingActivity = false
    if (hardTimer) clearTimeout(hardTimer)
    if (idleTimer) clearTimeout(idleTimer)

    if (reply instanceof Error && isRestartableTurnError(reply)) {
      await this.restartCodexChild(reply.message)
    }

    return reply
  }

  private async restartCodexChild(reason: string): Promise<void> {
    if (this.codexRecovery !== null) {
      await this.codexRecovery
      return
    }

    const recovery = this.performCodexRecovery(reason)
    this.codexRecovery = recovery
    try {
      await recovery
    } finally {
      if (this.codexRecovery === recovery) this.codexRecovery = null
    }
  }

  private async performCodexRecovery(reason: string): Promise<void> {
    const startedAt = Date.now()
    this.log(`[leuco] ${this.key}: recovering codex child (reason=${reason})`)
    this.liveCodexThreadIds.clear()
    this.codexGeneration += 1

    const stopResult = await this.codex.stop().catch((err: unknown) => err)
    if (this.stopped) {
      this.log(`[leuco] ${this.key}: codex recovery skipped because tenant is stopping`)
      return
    }

    if (this.codex.isRunning()) {
      const durationMs = Date.now() - startedAt
      const detail =
        stopResult instanceof Error ? `: ${errorMessage(stopResult)}` : " after stop completed"
      const recoveryError = `failed to stop unresponsive codex child${detail}`
      this.log(
        `[leuco] ${this.key}: codex recovery failed duration=${durationMs}ms: ${recoveryError}`,
      )
      this.bus.emit({
        ts: Date.now(),
        type: "codex.recovery",
        project: this.projectName,
        reason,
        status: "failed",
        durationMs,
        error: recoveryError,
      })
      return
    }

    const startResult = await this.codex.start().catch((err: unknown) => err)
    const durationMs = Date.now() - startedAt
    const recoveryError =
      startResult instanceof Error
        ? errorMessage(startResult)
        : !this.codex.isRunning()
          ? "codex child did not remain running after start"
          : null

    if (recoveryError !== null) {
      this.log(
        `[leuco] ${this.key}: codex recovery failed duration=${durationMs}ms: ${recoveryError}`,
      )
      this.bus.emit({
        ts: Date.now(),
        type: "codex.recovery",
        project: this.projectName,
        reason,
        status: "failed",
        durationMs,
        error: recoveryError,
      })
      return
    }

    const stopWarning =
      stopResult instanceof Error ? ` (stop warning: ${errorMessage(stopResult)})` : ""
    this.log(`[leuco] ${this.key}: codex recovery succeeded duration=${durationMs}ms${stopWarning}`)
    this.bus.emit({
      ts: Date.now(),
      type: "codex.recovery",
      project: this.projectName,
      reason,
      status: "succeeded",
      durationMs,
      error: stopResult instanceof Error ? errorMessage(stopResult) : null,
    })
  }

  private async ensureThread(threadKey: string): Promise<string | Error> {
    if (this.stopped) {
      return new Error(`tenant ${this.key} is stopped`)
    }

    // If the codex child died (SIGSEGV / OOM / external kill / `app-server`
    // exited cleanly), recover it once for every concurrent caller. Persisted
    // thread ids survive and are resumed below.
    if (!this.codex.isRunning()) {
      this.log(`[leuco] ${this.key}: codex child not running — respawning`)
      await this.restartCodexChild("codex child was not running before turn")
      if (!this.codex.isRunning()) {
        return new Error("codex respawn completed without a running child")
      }
    }

    const conversationKey = this.conversationKey(threadKey)
    const codexThreadId = this.getCodexThreadId(conversationKey)
    if (codexThreadId !== null && this.liveCodexThreadIds.has(codexThreadId)) {
      return codexThreadId
    }

    const developerInstructions = this.composeDeveloperInstructions()
    const requestGeneration = this.codexGeneration

    if (codexThreadId !== null) {
      const resumed = await this.codex.resumeThread({
        threadId: codexThreadId,
        cwd: this.projectPath,
        developerInstructions,
      })
      if (requestGeneration !== this.codexGeneration) {
        return new Error("codex app-server was replaced while resuming the thread")
      }
      if (resumed instanceof Error) return resumed
      if (resumed !== null) {
        this.setCodexThreadId(conversationKey, resumed.thread.id)
        this.liveCodexThreadIds.add(resumed.thread.id)
        this.log(
          `[leuco] resumed codex thread ${resumed.thread.id} for ${this.key}/${conversationKey}`,
        )
        return resumed.thread.id
      }
      this.log(`[leuco] thread ${codexThreadId} not found in codex sqlite; starting a new thread`)
      this.setCodexThreadId(conversationKey, null)
      this.persistThreads()
    }

    const result = await this.codex.startThread({
      cwd: this.projectPath,
      developerInstructions,
      model: this.agentSpec.model,
    })
    if (requestGeneration !== this.codexGeneration) {
      return new Error("codex app-server was replaced while starting the thread")
    }
    if (result instanceof Error) return result
    this.setCodexThreadId(conversationKey, result.thread.id)
    this.liveCodexThreadIds.add(result.thread.id)
    this.persistThreads()
    this.log(`[leuco] started codex thread ${result.thread.id} for ${this.key}/${conversationKey}`)
    return result.thread.id
  }

  private conversationKey(threadKey: string): string {
    return this.conversationScope === "project" ? this.key : threadKey
  }

  private getCodexThreadId(conversationKey: string): string | null {
    if (this.conversationScope === "project") return this.projectCodexThreadId
    return this.threadCodexThreadIds.get(conversationKey) ?? null
  }

  private setCodexThreadId(conversationKey: string, threadId: string | null): void {
    if (this.conversationScope === "project") {
      this.projectCodexThreadId = threadId
      return
    }
    if (threadId === null) {
      this.threadCodexThreadIds.delete(conversationKey)
      return
    }
    this.threadCodexThreadIds.set(conversationKey, threadId)
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

  private persistThreads(): void {
    const store = this.projectStateStore
    if (!store) return
    try {
      if (this.conversationScope === "project") {
        store.setCodexThreadId(this.projectId, this.projectCodexThreadId)
        return
      }
      store.setCodexThreadIds(this.projectId, Object.fromEntries(this.threadCodexThreadIds))
    } catch (err) {
      this.log(`[leuco] failed to persist threads: ${errorMessage(err)}`)
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
    error.message.startsWith("codex turn idle timed out") ||
    error.message.startsWith("codex command output exceeded") ||
    error.message.startsWith("codex app-server exited")
  )
}

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
}
