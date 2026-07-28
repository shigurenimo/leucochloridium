import type { Connector, ConnectorContext, RunTextTurnOptions } from "@/connectors/connector"
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
import { LeucoEventLog } from "@/events/leuco-event-log"
import { ProjectThreadRegistry, type ProjectThreadSummary } from "@/project/project-thread-registry"
import { ProjectTurnQueue, type QueuedProjectTurn } from "@/project/project-turn-queue"
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

export type ProjectAgentSpec = {
  developerInstructions?: string
  model?: string
}

export type LeucoProjectRuntimeProps = {
  projectId: string
  projectName: string
  projectPath: string
  codexHome?: string
  timeZone?: string
  agentSpec?: ProjectAgentSpec
  conversationScope?: ConversationScope
  initialCodexThreadId?: string
  initialCodexThreadIds?: Readonly<Record<string, string>>
  projectStateStore?: ProjectStateStorePort
  codex: CodexClientPort
  connectors: Connector[]
  useCommonInstructions?: boolean
  presets?: string[]
  /** `projectRuntimeSignature(project)` at build time; reconcile compares it
   * against the freshly loaded project to decide whether to rebuild. */
  configSignature?: string
  onLog?: Logger
  eventLog?: LeucoEventLog
  /** Hard wall-clock and no-notification limits. Overridable for tests. */
  turnTimeoutMs?: number
  turnIdleTimeoutMs?: number
  turnConcurrency?: number
  /** Pending-turn admission limits. Overridable for embedded runtimes and tests. */
  turnQueueMaxItems?: number
  turnQueueMaxBytes?: number
  turnTimeoutClock?: LeucoTurnTimeoutClock
}

export type ProjectRuntimeThreadSummary = ProjectThreadSummary

type CommandOutputOverflow = {
  callId: string
  threadId: string | null
}

/**
 * Owns one project: a single Codex app-server child and its connectors.
 * Conversation routing is configurable: project scope keeps one shared Codex
 * thread, while thread scope maps each connector-provided threadKey to a separate
 * Codex thread. Turns remain ordered within one conversation key.
 */
export class LeucoProjectRuntime {
  readonly projectId: string
  readonly projectName: string
  readonly projectPath: string
  readonly configSignature: string | null
  private readonly codexHome: string | null
  private readonly timeZone: string
  private readonly agentSpec: ProjectAgentSpec
  private readonly codex: CodexClientPort
  private readonly connectors: Connector[]
  private readonly log: Logger
  private readonly eventLog: LeucoEventLog
  private readonly threads: ProjectThreadRegistry
  private readonly useCommonInstructions: boolean
  private readonly presets: string[]
  private readonly turnTimeoutMs: number
  private readonly turnIdleTimeoutMs: number
  private readonly turnQueue: ProjectTurnQueue
  private readonly turnTimeoutClock: LeucoTurnTimeoutClock
  private codexGeneration = 0
  private codexRecovery: Promise<void> | null = null
  private stopped = false
  private readonly lastCommandOutputOverflows = new Map<string, CommandOutputOverflow>()

  constructor(props: LeucoProjectRuntimeProps) {
    this.projectId = props.projectId
    this.projectName = props.projectName
    this.projectPath = props.projectPath
    this.configSignature = props.configSignature ?? null
    this.codexHome = props.codexHome ?? null
    this.timeZone = props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    this.agentSpec = props.agentSpec ?? {}
    this.codex = props.codex
    this.connectors = props.connectors
    this.log = props.onLog ?? ((line) => process.stdout.write(`${line}\n`))
    this.eventLog = props.eventLog ?? new LeucoEventLog()
    this.threads = new ProjectThreadRegistry({
      projectId: props.projectId,
      projectName: props.projectName,
      scope: props.conversationScope ?? "project",
      initialThreadId: props.initialCodexThreadId,
      initialThreadIds: props.initialCodexThreadIds,
      stateStore: props.projectStateStore,
      onLog: this.log,
    })
    this.useCommonInstructions = props.useCommonInstructions ?? true
    this.presets = props.presets ?? []
    this.turnTimeoutMs = props.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.turnIdleTimeoutMs = props.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS
    const turnConcurrency = props.turnConcurrency ?? DEFAULT_TURN_CONCURRENCY
    const turnQueueMaxItems = props.turnQueueMaxItems ?? DEFAULT_TURN_QUEUE_MAX_ITEMS
    const turnQueueMaxBytes = props.turnQueueMaxBytes ?? DEFAULT_TURN_QUEUE_MAX_BYTES
    this.turnTimeoutClock = props.turnTimeoutClock ?? TURN_TIMEOUT_CLOCK
    assertPositiveInteger("turnTimeoutMs", this.turnTimeoutMs)
    assertPositiveInteger("turnIdleTimeoutMs", this.turnIdleTimeoutMs)
    assertPositiveInteger("turnConcurrency", turnConcurrency)
    assertPositiveInteger("turnQueueMaxItems", turnQueueMaxItems)
    assertPositiveInteger("turnQueueMaxBytes", turnQueueMaxBytes)
    this.turnQueue = new ProjectTurnQueue({
      projectName: this.projectName,
      concurrency: turnConcurrency,
      maxItems: turnQueueMaxItems,
      maxBytes: turnQueueMaxBytes,
      conversationKey: (threadKey) => this.threads.conversationKey(threadKey),
      execute: (turn) => this.executeTurn(turn),
      onLog: this.log,
      eventLog: this.eventLog,
    })
  }

  isCodexRunning(): boolean {
    return this.codex.isRunning()
  }

  listConnectors(): string[] {
    return this.connectors.map((connector) => connector.name)
  }

  listThreads(): ProjectRuntimeThreadSummary[] {
    return this.threads.list()
  }

  clearThread(threadKey: string): boolean {
    return this.threads.clear(threadKey)
  }

  async start(): Promise<void> {
    this.stopped = false
    this.turnQueue.start()
    this.log(`[leuco] starting codex app-server for ${this.projectName}`)
    await this.codex.start()

    const started: Connector[] = []
    try {
      for (const connector of this.connectors) {
        this.log(`[leuco] starting connector: ${connector.name} → ${this.projectName}`)
        await connector.start(this.connectorContext())
        started.push(connector)
      }
    } catch (error) {
      const rollbackStops = started.reverse().map((connector) =>
        connector.stop().catch((err: unknown) => {
          this.log(`[leuco] start rollback: connector ${connector.name} stop: ${errorMessage(err)}`)
        }),
      )
      await this.codex.stop().catch((err: unknown) => {
        this.log(`[leuco] start rollback: codex stop: ${errorMessage(err)}`)
      })
      await Promise.all(rollbackStops)
      throw error
    }

    this.eventLog.append({
      ts: Date.now(),
      type: "runtime.started",
      project: this.projectName,
    })
  }

  async restartConnector(connectorName: string, replacement?: Connector): Promise<void> {
    if (this.stopped) throw new Error(`project runtime ${this.projectName} is stopped`)
    const connectorIndex = this.connectors.findIndex(
      (candidate) => candidate.name === connectorName,
    )
    const current = this.connectors[connectorIndex]
    if (current === undefined) throw new Error(`connector not found: ${connectorName}`)

    const next = replacement ?? current
    if (next.name !== connectorName) {
      throw new Error(`replacement connector name mismatch: ${next.name}`)
    }

    this.log(`[leuco] restarting connector: ${current.name} → ${this.projectName}`)
    await current.stop()
    try {
      await next.start(this.connectorContext())
      this.connectors[connectorIndex] = next
    } catch (error) {
      await next.stop().catch((stopError: unknown) => {
        this.log(`[leuco] replacement connector ${next.name} cleanup: ${errorMessage(stopError)}`)
      })
      if (next !== current) await this.restoreConnector(current, error)
      throw error
    }
  }

  async stop(): Promise<void> {
    // Must flip before the codex kill: queued turns would otherwise see the
    // dead child in `ensureThread` and respawn a codex process nobody
    // supervises (the engine has already dropped this runtime by then).
    this.stopped = true
    this.turnQueue.stop()

    // Start every connector shutdown before killing Codex so each connector can
    // invalidate timers/generations immediately. Do not await their drains
    // yet: a schedule tick may itself be awaiting the active Codex turn.
    const connectorStops = this.connectors.map(async (connector) => {
      try {
        await connector.stop()
      } catch (err) {
        this.log(`[leuco] connector ${connector.name} stop: ${errorMessage(err)}`)
      }
    })

    await this.codex.stop().catch((err: unknown) => {
      this.log(`[leuco] codex stop (${this.projectName}): ${errorMessage(err)}`)
    })
    await Promise.all(connectorStops)

    this.eventLog.append({
      ts: Date.now(),
      type: "runtime.stopped",
      project: this.projectName,
    })
  }

  runTextTurn(
    threadKey: string,
    text: string,
    options: RunTextTurnOptions = {},
  ): Promise<string | Error> {
    return this.turnQueue.enqueue(threadKey, text, options)
  }

  private async executeTurn(pending: QueuedProjectTurn): Promise<string | Error> {
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
      this.eventLog.append({
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

      this.lastCommandOutputOverflows.delete(this.threads.conversationKey(pending.threadKey))
      const durationMs = Date.now() - startedAt
      this.log(
        `[leuco] ${this.projectName}: turn complete duration=${durationMs}ms wait=${queueWaitMs}ms replyChars=${reply.length}`,
      )
      this.eventLog.append({
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
    const conversationKey = this.threads.conversationKey(threadKey)
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
      this.threads.discard(conversationKey, `repeated command output overflow from ${callId}`)
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
    this.log(`[leuco] ${this.projectName}: recovering codex child (reason=${reason})`)
    this.threads.clearLive()
    this.codexGeneration += 1

    const stopResult = await this.codex.stop().catch((err: unknown) => err)
    if (this.stopped) {
      this.log(`[leuco] ${this.projectName}: codex recovery skipped because runtime is stopping`)
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
    this.log(
      `[leuco] ${this.projectName}: codex recovery succeeded duration=${durationMs}ms${stopWarning}`,
    )
    this.eventLog.append({
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
      `[leuco] ${this.projectName}: codex recovery failed duration=${durationMs}ms: ${recoveryError}`,
    )
    this.eventLog.append({
      ts: Date.now(),
      type: "codex.recovery",
      project: this.projectName,
      reason,
      status: "failed",
      durationMs,
      error: recoveryError,
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
      `[leuco] ${this.projectName}: turn error duration=${durationMs}ms wait=${queueWaitMs}ms: ${error.message}`,
    )
    this.eventLog.append({
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
    this.log(
      `[leuco] ${this.projectName}: clearing corrupt codex thread ${threadId}: ${error.message}`,
    )
    this.clearThread(threadId)
    return new Error("codex session history was corrupted and has been reset; please resend")
  }

  private async ensureThread(threadKey: string): Promise<string | Error> {
    if (this.stopped) {
      return new Error(`runtime ${this.projectName} is stopped`)
    }

    // If the codex child died (SIGSEGV / OOM / external kill / `app-server`
    // exited cleanly), recover it once for every concurrent caller. Persisted
    // thread ids survive and are resumed below.
    if (!this.codex.isRunning()) {
      this.log(`[leuco] ${this.projectName}: codex child not running — respawning`)
      await this.restartCodexChild("codex child was not running before turn")
      if (!this.codex.isRunning()) {
        return new Error("codex respawn completed without a running child")
      }
    }

    const conversationKey = this.threads.conversationKey(threadKey)
    const codexThreadId = this.threads.get(conversationKey)
    if (codexThreadId !== null && this.threads.isLive(codexThreadId)) {
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
        this.threads.discard(conversationKey, `history is corrupt: ${resumed.message}`)
      } else if (resumed !== null) {
        this.threads.set(conversationKey, resumed.thread.id)
        this.threads.markLive(resumed.thread.id)
        this.log(
          `[leuco] resumed codex thread ${resumed.thread.id} for ${this.projectName}/${conversationKey}`,
        )
        return resumed.thread.id
      } else {
        this.threads.discard(conversationKey, "not found in codex sqlite")
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
    this.threads.set(conversationKey, result.thread.id)
    this.threads.markLive(result.thread.id)
    this.threads.persist()
    this.log(
      `[leuco] started codex thread ${result.thread.id} for ${this.projectName}/${conversationKey}`,
    )
    return result.thread.id
  }

  private connectorContext(): ConnectorContext {
    return {
      cwd: this.projectPath,
      onLog: this.log,
      eventLog: this.eventLog,
      projectName: this.projectName,
      runTextTurn: (threadKey, text, options) => this.runTextTurn(threadKey, text, options),
    }
  }

  private async restoreConnector(connector: Connector, replacementError: unknown): Promise<void> {
    try {
      await connector.start(this.connectorContext())
    } catch (rollbackError) {
      throw new Error(
        `connector replacement failed (${errorMessage(replacementError)}); rollback failed: ${errorMessage(rollbackError)}`,
      )
    }
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
      identities: this.connectors.map((p) => p.getIdentity()),
      presets: this.presets,
      perAgentInstructions: tail,
      usePreamble: this.useCommonInstructions,
    })
    return builder.build()
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
