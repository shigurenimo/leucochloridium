import { Buffer } from "node:buffer"
import type { ChannelPlugin, RunTextTurnOptions, TurnPriority } from "@/channels/channel-plugin"
import type { ConversationScope } from "@/config/config-schema"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { isCodexHistoryCorruptionError } from "@/engine/codex/is-codex-history-corruption-error"
import { LeucoSystemPromptBuilder } from "@/prompts/system-prompt-builder"
import { LeucoTurnTimeouts } from "@/engine/turn-timeouts"
import type { LeucoTurnTimeoutClock } from "@/engine/turn-timeouts"
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

const MAX_EVENT_TEXT_CHARS = 16_000
const TURN_TIMEOUT_CLOCK: LeucoTurnTimeoutClock = {
  setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
  clearTimeout: (timer) => clearTimeout(timer),
}

type TurnRejectionReason = "tenant_stopped" | "queue_count_limit" | "queue_bytes_limit"

type TurnAdmissionRejection = {
  error: Error
  reason: TurnRejectionReason
}

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
  turnTimeoutClock?: LeucoTurnTimeoutClock
}

export type TenantThreadEntry = {
  threadKey: string
  threadId: string
}

type PendingTurn = {
  threadKey: string
  text: string
  enqueuedAt: number
  priority: TurnPriority
  resolve: (reply: string | Error) => void
}

type CommandOutputOverflow = {
  callId: string
  threadId: string | null
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
  private readonly turnTimeoutClock: LeucoTurnTimeoutClock
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
  private readonly lastCommandOutputOverflows = new Map<string, CommandOutputOverflow>()

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
    this.turnTimeoutClock = props.turnTimeoutClock ?? TURN_TIMEOUT_CLOCK
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
          runTextTurn: (threadKey, text, options) => this.runTextTurn(threadKey, text, options),
        })
        started.push(plugin)
      }
    } catch (error) {
      const rollbackStops = started.reverse().map((plugin) =>
        plugin.stop().catch((err: unknown) => {
          this.log(`[leuco] start rollback: plugin ${plugin.name} stop: ${errorMessage(err)}`)
        }),
      )
      await this.codex.stop().catch((err: unknown) => {
        this.log(`[leuco] start rollback: codex stop: ${errorMessage(err)}`)
      })
      await Promise.all(rollbackStops)
      throw error
    }

    this.bus.emit({
      ts: Date.now(),
      type: "tenant.started",
      project: this.projectName,
    })
  }

  async stop(): Promise<void> {
    // Must flip before the codex kill: queued turns would otherwise see the
    // dead child in `ensureThread` and respawn a codex process nobody
    // supervises (the engine has already dropped this tenant by then).
    this.stopped = true
    const cancelled = this.pendingTurns.splice(0)
    this.pendingTurnBytes = 0
    const stopError = new Error(`tenant ${this.key} is stopping`)
    for (const pending of cancelled) pending.resolve(stopError)

    // Start every plugin shutdown before killing Codex so each plugin can
    // invalidate timers/generations immediately. Do not await their drains
    // yet: a schedule tick may itself be awaiting the active Codex turn.
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

  runTextTurn(
    threadKey: string,
    text: string,
    options: RunTextTurnOptions = {},
  ): Promise<string | Error> {
    const inputBytes = Buffer.byteLength(text, "utf8")
    const priority = options.priority ?? "normal"
    if (priority === "high" && !this.stopped && inputBytes <= this.turnQueueMaxBytes) {
      this.makeRoomForHighPriorityTurn(inputBytes)
    }
    const rejection = this.getTurnAdmissionRejection(inputBytes)
    if (rejection !== null) {
      this.emitTurnRejected(threadKey, rejection.reason, inputBytes)
      return Promise.resolve(rejection.error)
    }

    return new Promise<string | Error>((resolve) => {
      const queueDepth = this.pendingTurns.length + 1
      const queueBytes = this.pendingTurnBytes + inputBytes

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
      const pending = {
        threadKey,
        text,
        enqueuedAt: Date.now(),
        priority,
        resolve,
      }
      const firstNormal = this.pendingTurns.findIndex(
        (candidate) => candidate.priority === "normal",
      )
      if (priority === "high" && firstNormal >= 0) {
        this.pendingTurns.splice(firstNormal, 0, pending)
      } else {
        this.pendingTurns.push(pending)
      }
      this.drainTurns()
    })
  }

  /**
   * Addressed work must not disappear behind a queue filled by ambient
   * channel chatter. An already-running turn is never interrupted.
   */
  private makeRoomForHighPriorityTurn(inputBytes: number): void {
    while (
      this.pendingTurns.length >= this.turnQueueMaxItems ||
      this.pendingTurnBytes + inputBytes > this.turnQueueMaxBytes
    ) {
      const normalIndex = this.pendingTurns.findLastIndex(
        (candidate) => candidate.priority === "normal",
      )
      if (normalIndex < 0) return

      const evicted = this.pendingTurns.splice(normalIndex, 1)[0]
      if (evicted === undefined) return
      const evictedBytes = Buffer.byteLength(evicted.text, "utf8")
      this.pendingTurnBytes = Math.max(0, this.pendingTurnBytes - evictedBytes)
      const reason: TurnRejectionReason =
        this.pendingTurns.length + 1 >= this.turnQueueMaxItems
          ? "queue_count_limit"
          : "queue_bytes_limit"
      this.emitTurnRejected(evicted.threadKey, reason, evictedBytes)
      evicted.resolve(
        new Error(`tenant ${this.key} deferred turn was superseded by addressed work`),
      )
    }
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
    const queueWaitMs = Math.max(0, startedAt - pending.enqueuedAt)
    const timeouts = new LeucoTurnTimeouts({
      hardTimeoutMs: this.turnTimeoutMs,
      idleTimeoutMs: this.turnIdleTimeoutMs,
      clock: this.turnTimeoutClock,
    })

    try {
      const threadIdOrError = await Promise.race([
        this.ensureThread(pending.threadKey),
        timeouts.hardTimeout,
      ])
      if (threadIdOrError instanceof Error) {
        await this.recoverRestartableTurn(pending.threadKey, null, threadIdOrError, timeouts)
        this.emitTurnError(pending.threadKey, threadIdOrError, startedAt, queueWaitMs)
        return threadIdOrError
      }
      const threadId = threadIdOrError

      this.log(`[leuco] turn → ${threadId} wait=${queueWaitMs}ms (${truncate(pending.text, 60)})`)
      this.bus.emit({
        ts: Date.now(),
        type: "turn.start",
        project: this.projectName,
        threadKey: pending.threadKey,
        input: toEventText(pending.text),
        inputChars: pending.text.length,
        inputTruncated: pending.text.length > MAX_EVENT_TEXT_CHARS,
        batchSize: 1,
        queueWaitMs,
      })

      timeouts.startIdle()
      const reply = await this.runCodexTurn(pending.threadKey, threadId, pending.text, timeouts)
      if (reply instanceof Error) {
        const recoveredReply = this.recoverCorruptTurnHistory(threadId, reply)
        this.emitTurnError(pending.threadKey, recoveredReply, startedAt, queueWaitMs)
        return recoveredReply
      }

      this.lastCommandOutputOverflows.delete(this.conversationKey(pending.threadKey))
      const durationMs = Date.now() - startedAt
      this.log(
        `[leuco] ${this.key}: turn complete duration=${durationMs}ms wait=${queueWaitMs}ms replyChars=${reply.length}`,
      )
      this.bus.emit({
        ts: Date.now(),
        type: "turn.complete",
        project: this.projectName,
        threadKey: pending.threadKey,
        reply: toEventText(reply),
        replyChars: reply.length,
        replyTruncated: reply.length > MAX_EVENT_TEXT_CHARS,
        durationMs,
        queueWaitMs,
      })
      return reply
    } finally {
      timeouts.clear()
    }
  }

  private async runCodexTurn(
    threadKey: string,
    threadId: string,
    text: string,
    timeouts: LeucoTurnTimeouts,
  ): Promise<string | Error> {
    const reply = await Promise.race([
      this.codex.runTextTurn(threadId, text, {
        cwd: this.projectPath,
        onActivity: () => timeouts.activity(),
      }),
      timeouts.hardTimeout,
      timeouts.idleTimeout,
    ])
    if (reply instanceof Error) {
      await this.recoverRestartableTurn(threadKey, threadId, reply, timeouts)
    }
    return reply
  }

  private async recoverRestartableTurn(
    threadKey: string,
    threadId: string | null,
    error: Error,
    timeouts: LeucoTurnTimeouts,
  ): Promise<void> {
    const conversationKey = this.conversationKey(threadKey)
    if (timeouts.isTimeout(error)) {
      this.lastCommandOutputOverflows.delete(conversationKey)
      await this.restartCodexChild(error.message)
      return
    }

    const callId = commandOutputOverflowCallId(error)
    if (callId === null) {
      this.lastCommandOutputOverflows.delete(conversationKey)
      if (isRestartableTurnError(error)) await this.restartCodexChild(error.message)
      return
    }

    const current = { callId, threadId }
    const previous = this.lastCommandOutputOverflows.get(conversationKey)
    if (previous?.callId === current.callId && previous.threadId === current.threadId) {
      this.discardPersistedThread(
        conversationKey,
        `repeated command output overflow from ${callId}`,
      )
      this.lastCommandOutputOverflows.delete(conversationKey)
    } else {
      this.lastCommandOutputOverflows.set(conversationKey, current)
    }
    await this.restartCodexChild(error.message)
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
      const detail =
        stopResult instanceof Error ? `: ${errorMessage(stopResult)}` : " after stop completed"
      this.emitRecoveryFailure(
        reason,
        startedAt,
        `failed to stop unresponsive codex child${detail}`,
      )
      return
    }

    const startResult = await this.codex.start().catch((err: unknown) => err)
    const recoveryError =
      startResult instanceof Error
        ? errorMessage(startResult)
        : !this.codex.isRunning()
          ? "codex child did not remain running after start"
          : null
    if (recoveryError !== null) {
      this.emitRecoveryFailure(reason, startedAt, recoveryError)
      return
    }

    const durationMs = Date.now() - startedAt
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

  private emitRecoveryFailure(reason: string, startedAt: number, recoveryError: string): void {
    const durationMs = Date.now() - startedAt
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
  }

  private getTurnAdmissionRejection(queuedBytes: number): TurnAdmissionRejection | null {
    if (this.stopped) {
      return {
        error: new Error(`tenant ${this.key} is stopping`),
        reason: "tenant_stopped",
      }
    }
    if (this.pendingTurns.length >= this.turnQueueMaxItems) {
      return {
        error: new Error(
          `tenant ${this.key} turn queue is full (${this.turnQueueMaxItems} pending)`,
        ),
        reason: "queue_count_limit",
      }
    }
    if (this.pendingTurnBytes + queuedBytes > this.turnQueueMaxBytes) {
      return {
        error: new Error(
          `tenant ${this.key} turn queue exceeds ${this.turnQueueMaxBytes} UTF-8 bytes`,
        ),
        reason: "queue_bytes_limit",
      }
    }
    return null
  }

  private emitTurnRejected(
    threadKey: string,
    reason: TurnRejectionReason,
    inputBytes: number,
  ): void {
    this.bus.emit({
      ts: Date.now(),
      type: "turn.rejected",
      project: this.projectName,
      threadKey,
      reason,
      queueDepth: this.pendingTurns.length,
      queueBytes: this.pendingTurnBytes,
      inputBytes,
      maxQueueDepth: this.turnQueueMaxItems,
      maxQueueBytes: this.turnQueueMaxBytes,
    })
  }

  private emitTurnError(
    threadKey: string,
    error: Error,
    startedAt: number,
    queueWaitMs: number,
  ): void {
    const durationMs = Date.now() - startedAt
    this.log(
      `[leuco] ${this.key}: turn error duration=${durationMs}ms wait=${queueWaitMs}ms: ${error.message}`,
    )
    this.bus.emit({
      ts: Date.now(),
      type: "turn.error",
      project: this.projectName,
      threadKey,
      error: toEventText(error.message),
      durationMs,
      queueWaitMs,
    })
  }

  private recoverCorruptTurnHistory(threadId: string, error: Error): Error {
    if (!isCodexHistoryCorruptionError(error)) return error
    this.log(`[leuco] ${this.key}: clearing corrupt codex thread ${threadId}: ${error.message}`)
    this.clearThread(threadId)
    return new Error("codex session history was corrupted and has been reset; please resend")
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
      if (resumed instanceof Error) {
        if (!isCodexHistoryCorruptionError(resumed)) return resumed
        this.discardPersistedThread(conversationKey, `history is corrupt: ${resumed.message}`)
      } else if (resumed !== null) {
        this.setCodexThreadId(conversationKey, resumed.thread.id)
        this.liveCodexThreadIds.add(resumed.thread.id)
        this.log(
          `[leuco] resumed codex thread ${resumed.thread.id} for ${this.key}/${conversationKey}`,
        )
        return resumed.thread.id
      } else {
        this.discardPersistedThread(conversationKey, "not found in codex sqlite")
      }
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

  private discardPersistedThread(conversationKey: string, reason: string): void {
    const threadId = this.getCodexThreadId(conversationKey)
    this.log(`[leuco] thread ${threadId ?? "unknown"} ${reason}; starting a new thread`)
    if (threadId !== null) this.liveCodexThreadIds.delete(threadId)
    this.setCodexThreadId(conversationKey, null)
    this.persistThreads()
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
    error.message.startsWith("codex turn hard deadline exceeded") ||
    error.message.startsWith("codex turn idle timeout") ||
    error.message.startsWith("codex command output exceeded") ||
    error.message.startsWith("codex protocol frame exceeded") ||
    error.message.startsWith("codex stdin failed") ||
    error.message.startsWith("codex app-server exited")
  )
}

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
}

const toEventText = (text: string): string => {
  if (text.length <= MAX_EVENT_TEXT_CHARS) return text
  const suffix = `… [${text.length} chars]`
  return `${text.slice(0, MAX_EVENT_TEXT_CHARS - suffix.length)}${suffix}`
}

const commandOutputOverflowCallId = (error: Error): string | null => {
  const match = error.message.match(
    /(?:^|:\s*)codex command output exceeded \d+ chars from (call_[a-z0-9_-]+)/i,
  )
  return match?.[1] ?? null
}
