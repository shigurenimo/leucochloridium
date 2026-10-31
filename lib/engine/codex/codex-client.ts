import { getCodexProtocolLimits } from "@/engine/codex/get-codex-protocol-limits"
import { MAX_TIMER_DELAY_MS } from "@/timer-limits"
import pkg from "leuco/package.json" with { type: "json" }
import { CodexTurnText } from "@/engine/codex/codex-turn-text"
import { CodexConsumerDiagnostics } from "@/engine/codex/codex-consumer-diagnostics"
import type { DiagnosticOutput } from "@/diagnostic-output"
import { formatCodexConsumerError } from "@/engine/codex/format-codex-consumer-error"
import { isCodexThreadMissingError } from "@/engine/codex/is-codex-thread-missing-error"
import { CodexPendingNotifications } from "@/engine/codex/codex-pending-notifications"
import { spawn } from "node:child_process"
import type { LogLevel } from "@/log-level"
import { CodexStderrLog } from "@/engine/codex/codex-stderr-log"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { LeucoCodexProtocol } from "@/engine/codex/codex-protocol"
import { CodexRequestTimeoutError } from "@/engine/codex/codex-request-timeout-error"
import {
  agentMessageDeltaSchema,
  commandExecutionOutputDeltaSchema,
  itemCompletedSchema,
  threadStartResultSchema,
  turnCompletedIdentitySchema,
  turnNotificationIdentitySchema,
  turnStartResultSchema,
} from "@/engine/codex/codex-schemas"
import type { ThreadStartResult, TurnStartResult } from "@/engine/codex/codex-schemas"
import { turnCompletedSchema } from "@/engine/codex/codex-schemas"
import type { CodexTurnOptions } from "@/engine/codex/codex-client-port"
import type {
  ThreadResumeParams,
  ThreadStartParams,
  TurnInputItem,
  TurnStartParams,
} from "@/engine/codex/codex-types"
import { errorMessage } from "@/error-message"

type NotificationHandler = (method: string, params: unknown, requestId?: string) => void

type ActiveTurn = {
  id: string | null
}

type TrackedTurn = { handler: NotificationHandler; turn: ActiveTurn; requestId?: string }

export type LeucoCodexClientProps = {
  bin?: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  onLog?: (line: string, level?: LogLevel) => void
  /**
   * Called for every JSON-RPC notification from codex BEFORE per-turn handlers
   * (`collectTurn`'s temporary handler chains to whatever was set previously).
   * requestId is supplied only after both thread and turn identity are confirmed.
   * Useful for broadcasting to the structured event log.
   */
  onAnyNotification?: NotificationHandler
  commandOutputLimitChars?: number
  threadRequestTimeoutMs?: number
  protocolMaxFrameChars?: number
  protocolLogPreviewChars?: number
  redactLogText?: (text: string) => string
  diagnosticOutput?: DiagnosticOutput
}

/**
 * `codex app-server` child process supervisor. Owns spawn / stdin pipe / exit
 * handling, and delegates JSON-RPC framing to `LeucoCodexProtocol`. High-level
 * methods (`startThread`, `runTextTurn`) parse responses with zod.
 */
export class LeucoCodexClient {
  private readonly bin: string
  private readonly args: string[]
  private readonly cwd: string | undefined
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly onLog: ((line: string, level?: LogLevel) => void) | undefined
  private readonly commandOutputLimitChars: number
  private readonly threadRequestTimeoutMs: number
  private readonly protocolMaxFrameChars: number
  private readonly protocolLogPreviewChars: number
  private readonly redactLogText: ((text: string) => string) | undefined

  private readonly consumerDiagnostics: CodexConsumerDiagnostics

  private starting: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private initialized = false
  private child: ChildProcessWithoutNullStreams | null = null
  private protocol: LeucoCodexProtocol | null = null
  private readonly notificationHandler: NotificationHandler | null
  private readonly turnHandlers = new Map<string, TrackedTurn>()
  private exitPromise: Promise<void> | null = null
  private transportFailurePromise: Promise<void> | null = null
  /**
   * In-flight `collectTurnInternal` rejecters. The protocol layer rejects
   * pending JSON-RPC requests on transport failure, but turn collection
   * waits on streamed notifications instead — without this registry a
   * codex crash mid-turn would hang the awaiting Promise forever.
   */
  private readonly turnAborters = new Set<(err: Error) => void>()

  constructor(props: LeucoCodexClientProps = {}) {
    this.bin = props.bin ?? "codex"
    this.args = props.args === undefined ? ["app-server"] : [...props.args]
    this.cwd = props.cwd
    this.env = props.env === undefined ? undefined : { ...props.env }
    this.consumerDiagnostics = new CodexConsumerDiagnostics({
      output: props.diagnosticOutput,
      redactLogText: props.redactLogText,
    })
    const onLog = props.onLog
    this.onLog =
      onLog === undefined
        ? undefined
        : (line, level) => {
            try {
              onLog(line, level)
            } catch (error) {
              this.consumerDiagnostics.report({ kind: "log", error })
            }
          }
    this.commandOutputLimitChars = props.commandOutputLimitChars ?? COMMAND_OUTPUT_LIMIT_CHARS
    this.threadRequestTimeoutMs = props.threadRequestTimeoutMs ?? THREAD_REQUEST_TIMEOUT_MS
    const protocolLimits = getCodexProtocolLimits({
      maxFrameChars: props.protocolMaxFrameChars,
      logPreviewChars: props.protocolLogPreviewChars,
    })
    this.protocolMaxFrameChars = protocolLimits.maxFrameChars
    this.protocolLogPreviewChars = protocolLimits.logPreviewChars
    this.validateLimits()
    this.redactLogText = props.redactLogText
    this.notificationHandler = props.onAnyNotification ?? null
  }

  private validateLimits(): void {
    if (!Number.isSafeInteger(this.commandOutputLimitChars) || this.commandOutputLimitChars < 0)
      throw new Error("commandOutputLimitChars must be a non-negative safe integer")
    if (
      !Number.isSafeInteger(this.threadRequestTimeoutMs) ||
      this.threadRequestTimeoutMs < 1 ||
      this.threadRequestTimeoutMs > MAX_TIMER_DELAY_MS
    )
      throw new Error(
        `threadRequestTimeoutMs must be whole milliseconds between 1 and ${MAX_TIMER_DELAY_MS}`,
      )
  }

  isRunning(): boolean {
    return this.child !== null && this.protocol !== null && this.initialized
  }

  getStatus() {
    return {
      pid: this.child?.pid ?? null,
      ready: this.isRunning(),
      starting: this.starting !== null,
      stopping: this.stopping !== null,
      cleaningUp: this.transportFailurePromise !== null,
      activeTurns: this.turnAborters.size,
      diagnostics: this.consumerDiagnostics.getHealth(),
    }
  }

  async start(): Promise<void> {
    if (this.starting !== null) return this.starting
    if (this.stopping !== null) await this.stopping
    const starting = this.startChild()
    this.starting = starting
    try {
      await starting
    } finally {
      if (this.starting === starting) this.starting = null
    }
  }

  private async startChild(): Promise<void> {
    const transportFailurePromise = this.transportFailurePromise
    if (transportFailurePromise !== null) await transportFailurePromise
    if (this.child !== null) {
      if (this.protocol === null)
        throw new Error(
          "Previous Codex process has not exited after transport failure; refusing to spawn a duplicate. Inspect logs and stop it before retrying.",
        )
      return
    }

    const child = spawn(this.bin, this.args, {
      cwd: this.cwd,
      env: this.env ?? process.env,
      stdio: "pipe",
    })

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")

    const protocol = new LeucoCodexProtocol({
      writer: (line) => child.stdin.write(line),
      onLog: this.onLog,
      maxFrameChars: this.protocolMaxFrameChars,
      logPreviewChars: this.protocolLogPreviewChars,
      redactLogText: this.redactLogText,
    })
    protocol.onNotification((method, params) => this.handleNotification(method, params))

    child.stdout.on("data", (chunk: string) => {
      if (this.protocol !== protocol) return

      const frameError = protocol.feedChunk(chunk)
      if (frameError !== null) void this.failTransport(child, protocol, frameError)
    })

    const stderrLog = new CodexStderrLog((line, level) => this.onLog?.(line, level))
    child.stderr.on("data", (chunk: string) => stderrLog.write(chunk))
    child.stderr.on("end", () => stderrLog.flush())

    // A write racing the pipe closing surfaces asynchronously as a stream
    // `error` event; without a listener Node turns it into an
    // uncaughtException that takes the whole daemon down with it.
    child.stdin.on("error", (err: Error) => {
      if (this.onLog) this.onLog(`[codex stdin] ${errorMessage(err)}`, "error")
      void this.failTransport(
        child,
        protocol,
        new Error(`codex stdin failed: ${errorMessage(err)}`),
      )
    })

    this.exitPromise = new Promise((resolve) => {
      const settle = (exitError: Error): void => {
        protocol.fail(exitError)
        if (this.child === child) {
          this.abortInFlightTurns(exitError)
          this.child = null
          this.protocol = null
        }
        resolve()
      }

      child.once("exit", (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`
        this.onLog?.(
          `[codex] app-server exited (${reason})`,
          code === 0 && !signal ? "info" : "warn",
        )
        settle(new Error(`codex app-server exited (${reason})`))
      })

      // A failed spawn (binary missing, EACCES) emits `error` and never
      // `exit`; `child.pid` stays undefined in that case. Settling here is
      // what keeps `isRunning()` truthful — otherwise the dead child sticks
      // around forever and the Leuco runtime never respawns. When `pid` exists the
      // process may still be alive (e.g. a kill failure), so only the
      // in-flight work is failed.
      child.once("error", (err) => {
        this.onLog?.(`[codex] app-server error: ${errorMessage(err)}`, "error")
        if (child.pid === undefined) {
          settle(err)
          return
        }
        protocol.fail(err)
        if (this.child === child) this.abortInFlightTurns(err)
      })
    })

    this.child = child
    this.protocol = protocol
    this.initialized = false

    // Mandatory handshake. codex app-server rejects every other request with
    // `Not initialized` until `initialize` completes. If the request fails
    // (bad CODEX_HOME, codex binary missing capabilities, etc.) we must kill
    // the spawned child here — otherwise the caller's `start()` rejects with
    // no live `LeucoCodexClient` reference to call `stop()` on, leaving a
    // zombie codex process. A wall-clock timeout protects against the child
    // accepting stdio but never replying (FS lock, codex bug, broken sandbox).
    try {
      await withTimeout(
        protocol.request("initialize", {
          clientInfo: {
            name: "leuco",
            title: "leucochloridium",
            version: pkg.version,
          },
        }),
        INITIALIZE_TIMEOUT_MS,
        `codex initialize timed out after ${INITIALIZE_TIMEOUT_MS / 1000}s`,
      )
    } catch (err) {
      const error = err instanceof Error ? err : new Error(errorMessage(err))
      await this.failTransport(child, protocol, error)
      throw error
    }
    if (this.child !== child || this.protocol !== protocol)
      throw new Error("Codex stopped during initialization")
    protocol.notify("initialized")
    this.initialized = true
    this.onLog?.(`[codex] app-server ready (pid=${child.pid ?? "unknown"})`)
    if (this.child !== child || this.protocol !== protocol || !this.initialized)
      throw new Error("Codex stopped during initialization")
  }

  async stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping
    const stopping = this.stopChild().finally(() => this.consumerDiagnostics.drain())
    this.stopping = stopping
    try {
      await stopping
    } finally {
      if (this.stopping === stopping) this.stopping = null
    }
  }

  private async stopChild(): Promise<void> {
    const transportFailurePromise = this.transportFailurePromise
    if (transportFailurePromise !== null) await transportFailurePromise

    const child = this.child
    if (child === null) return
    const cancelled = new Error("Codex stopped")
    this.protocol?.fail(cancelled)
    this.protocol = null
    this.initialized = false
    this.abortInFlightTurns(cancelled)
    child.stdin.end()
    child.kill("SIGTERM")
    await this.waitForExitOrEscalate(child)
  }

  private failTransport(
    child: ChildProcessWithoutNullStreams,
    protocol: LeucoCodexProtocol,
    error: Error,
  ): Promise<void> {
    protocol.fail(error)
    if (this.child !== child || this.protocol !== protocol) {
      return this.transportFailurePromise ?? Promise.resolve()
    }

    this.protocol = null
    this.abortInFlightTurns(error)

    const cleanup = this.terminateFailedChild(child)
      .catch((err: unknown) => {
        if (this.onLog) this.onLog(`[codex cleanup] ${errorMessage(err)}`)
      })
      .finally(() => {
        if (this.transportFailurePromise === cleanup) this.transportFailurePromise = null
      })
    this.transportFailurePromise = cleanup
    return cleanup
  }

  private async terminateFailedChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    child.stdin.destroy()
    child.kill("SIGTERM")
    await this.waitForExitOrEscalate(child)
  }

  private async waitForExitOrEscalate(child: ChildProcessWithoutNullStreams): Promise<void> {
    const exit = this.exitPromise
    if (!exit) return

    const termRace = await raceExitOrTimeout(exit, STOP_TERM_GRACE_MS)
    if (termRace === "exited") return

    child.kill("SIGKILL")
    const killRace = await raceExitOrTimeout(exit, STOP_KILL_GRACE_MS)
    if (killRace === "timeout") {
      throw new Error(
        `codex app-server did not exit within ${STOP_KILL_GRACE_MS / 1000}s after SIGKILL`,
      )
    }
  }

  async getDeveloperInstructions(): Promise<string> {
    if (!this.protocol) throw new Error("codex client not started")
    const response = await withTimeout(
      this.protocol.request("config/read", { includeLayers: false }),
      this.threadRequestTimeoutMs,
      "codex config/read timed out",
    )
    if (typeof response !== "object" || response === null || !("config" in response)) {
      throw new Error("codex config/read returned no config")
    }
    const config = response.config
    if (typeof config !== "object" || config === null || !("developer_instructions" in config))
      return ""
    if (config.developer_instructions === null || config.developer_instructions === undefined)
      return ""
    if (typeof config.developer_instructions !== "string")
      throw new Error("Invalid Codex developer instructions")
    return config.developer_instructions
  }

  async startThread(params: ThreadStartParams): Promise<ThreadStartResult | Error> {
    const protocol = this.protocol
    const child = this.child
    if (!protocol || !child) return new Error("codex client not started")
    // Both `protocol.request` (rejects on JSON-RPC error) and `parse` (throws
    // on schema drift) need to fold into the `| Error` contract that every
    // other method honours; otherwise the rejection becomes an unhandled
    // rejection in the engine layer.
    try {
      const result = await withTimeout(
        protocol.request("thread/start", params),
        this.threadRequestTimeoutMs,
        `codex thread/start timed out after ${this.threadRequestTimeoutMs / 1000}s`,
      )
      return threadStartResultSchema.parse(result)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(errorMessage(err))
      if (error instanceof CodexRequestTimeoutError) {
        await this.failTransport(child, protocol, error)
      }
      return error
    }
  }

  /**
   * Re-load a previously persisted thread from codex's sqlite and make it
   * the active session. Resolves to `null` (not Error) when codex reports
   * the thread cannot be found, so callers can transparently fall back to
   * `startThread` for stale ids.
   */
  async resumeThread(params: ThreadResumeParams): Promise<ThreadStartResult | null | Error> {
    const protocol = this.protocol
    const child = this.child
    if (!protocol || !child) return new Error("codex client not started")
    try {
      const result = await withTimeout(
        protocol.request("thread/resume", params),
        this.threadRequestTimeoutMs,
        `codex thread/resume timed out after ${this.threadRequestTimeoutMs / 1000}s`,
      )
      return threadStartResultSchema.parse(result)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(errorMessage(err))
      if (error instanceof CodexRequestTimeoutError) {
        await this.failTransport(child, protocol, error)
        return error
      }
      if (isCodexThreadMissingError(error, params.threadId)) return null
      return error
    }
  }

  private async startTurn(params: TurnStartParams): Promise<TurnStartResult | Error> {
    const protocol = this.protocol
    if (!protocol) return new Error("codex client not started")
    try {
      const result = await protocol.request("turn/start", params)
      return turnStartResultSchema.parse(result)
    } catch (err) {
      return err instanceof Error ? err : new Error(errorMessage(err))
    }
  }

  /**
   * Send a single text-input turn and resolve when it completes. Returns the
   * concatenated assistant text — preferring `item/completed` agentMessage
   * text, falling back to streamed `item/agentMessage/delta`.
   */
  runTextTurn(threadId: string, text: string, options?: CodexTurnOptions): Promise<string | Error> {
    const input: TurnInputItem[] = [{ type: "text", text }]
    return this.collectTurn({ threadId, input, cwd: options?.cwd }, options)
  }

  private async collectTurn(
    params: TurnStartParams,
    options?: CodexTurnOptions,
  ): Promise<string | Error> {
    const protocol = this.protocol
    if (!protocol) return new Error("codex client not started")
    try {
      return await this.collectTurnInternal(protocol, params, options)
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err))
    }
  }

  private collectTurnInternal(
    protocol: LeucoCodexProtocol,
    params: TurnStartParams,
    options?: CodexTurnOptions,
  ): Promise<string> {
    const onActivity = options?.onActivity
    return new Promise<string>((resolve, reject) => {
      const text = new CodexTurnText()
      const bufferedNotifications = new CodexPendingNotifications()
      const activeTurn: ActiveTurn = { id: null }
      const commandOutputState = { chars: 0 }
      const lifecycle = { isTornDown: false }

      if (this.protocol !== protocol) {
        reject(new Error("codex transport changed before turn collection started"))
        return
      }
      if (this.turnHandlers.has(params.threadId)) {
        reject(new Error(`codex thread ${params.threadId} already has a turn in flight`))
        return
      }

      const aborter = (err: Error): void => {
        teardown()
        reject(err)
      }

      const teardown = (): void => {
        if (lifecycle.isTornDown) return
        lifecycle.isTornDown = true
        bufferedNotifications.clear()
        text.clear()
        if (this.turnHandlers.get(params.threadId)?.handler === handler) {
          this.turnHandlers.delete(params.threadId)
        }
        this.turnAborters.delete(aborter)
      }

      const failCollection = (error: unknown): void => {
        teardown()
        void this.stop().then(
          () => reject(error),
          (cleanupError: unknown) =>
            reject(new AggregateError([error, cleanupError], "Codex turn cleanup failed")),
        )
      }

      const processNotification = (method: string, raw: unknown, canBuffer: boolean): void => {
        if (method === "item/agentMessage/delta") {
          const parsed = agentMessageDeltaSchema.safeParse(raw)
          if (!parsed.success || parsed.data.threadId !== params.threadId) return
          if (activeTurn.id === null) {
            if (canBuffer) bufferedNotifications.push(method, raw)
            return
          }
          if (parsed.data.turnId === activeTurn.id) text.appendDelta(parsed.data.delta)
          return
        }

        if (method === "item/commandExecution/outputDelta") {
          const parsed = commandExecutionOutputDeltaSchema.safeParse(raw)
          if (!parsed.success) return
          const identity = turnNotificationIdentitySchema.safeParse(raw)
          if (!identity.success || identity.data.threadId !== params.threadId) return
          if (activeTurn.id === null) {
            if (canBuffer) bufferedNotifications.push(method, raw)
            return
          }
          const turnId = identity.data.turnId
          if (turnId !== activeTurn.id) return

          commandOutputState.chars += parsed.data.delta.length
          if (commandOutputState.chars <= this.commandOutputLimitChars) return

          const item = parsed.data.itemId ? ` from ${parsed.data.itemId}` : ""
          const err = new Error(
            `codex command output exceeded ${this.commandOutputLimitChars} chars${item}`,
          )
          failCollection(err)
          return
        }

        if (method === "item/completed") {
          const parsed = itemCompletedSchema.safeParse(raw)
          if (!parsed.success || parsed.data.threadId !== params.threadId) return
          if (activeTurn.id === null) {
            if (canBuffer) bufferedNotifications.push(method, raw)
            return
          }
          if (
            parsed.data.turnId === activeTurn.id &&
            parsed.data.item.type === "agentMessage" &&
            typeof parsed.data.item.text === "string"
          ) {
            text.complete(parsed.data.item.text, parsed.data.item.phase)
          }
          return
        }

        if (method === "turn/completed") {
          const parsed = turnCompletedSchema.safeParse(raw)
          if (!parsed.success) {
            const identity = turnCompletedIdentitySchema.safeParse(raw)
            if (!identity.success || identity.data.threadId !== params.threadId) return
            if (activeTurn.id === null) {
              if (canBuffer) bufferedNotifications.push(method, raw)
              return
            }
            if (identity.data.turn.id !== activeTurn.id) return

            teardown()
            reject(new Error(`invalid turn/completed: ${parsed.error.message}`))
            return
          }
          if (parsed.data.threadId !== params.threadId) return
          if (activeTurn.id === null) {
            if (canBuffer) bufferedNotifications.push(method, raw)
            return
          }
          if (parsed.data.turn.id !== activeTurn.id) return

          const turn = parsed.data.turn
          if (turn.status !== "completed") {
            teardown()
            const message =
              getTurnErrorMessage(turn.error) ?? `codex turn ${turn.id} ${turn.status}`
            reject(new Error(message))
            return
          }
          const finalText = text.getText()
          teardown()
          resolve(finalText)
        }
      }

      const collectNotification = (method: string, raw: unknown, canBuffer: boolean): void => {
        try {
          processNotification(method, raw, canBuffer)
        } catch (error) {
          failCollection(error)
        }
      }

      const signalActivity = (method: string): void => {
        if (!onActivity) return
        try {
          onActivity(method)
        } catch (err) {
          if (this.onLog) this.onLog(`[codex activity] ${errorMessage(err)}`)
        }
      }

      const noteActivity = (method: string, raw: unknown): void => {
        if (!onActivity || activeTurn.id === null) return
        const parsed = turnNotificationIdentitySchema.safeParse(raw)
        if (!parsed.success || parsed.data.threadId !== params.threadId) return
        const turnId = parsed.data.turnId
        if (turnId === activeTurn.id) signalActivity(method)
      }

      const handler: NotificationHandler = (method, raw) => {
        noteActivity(method, raw)
        collectNotification(method, raw, true)
      }

      this.turnHandlers.set(params.threadId, {
        handler,
        turn: activeTurn,
        requestId: options?.requestId,
      })
      this.turnAborters.add(aborter)

      // `startTurn` always resolves (errors are folded into `| Error`), so a
      // single `.then` is enough — settling here rejects the outer promise
      // when codex never sends `turn/completed`. Without this `runTextTurn`
      // would hang until the Leuco runtime's wall-clock timeout kicks in.
      void this.startTurn(params).then((result) => {
        if (lifecycle.isTornDown) return
        if (result instanceof Error) {
          teardown()
          reject(result)
          return
        }

        activeTurn.id = result.turn.id
        signalActivity("turn/start")
        const buffered = bufferedNotifications.drain()
        for (const notification of buffered) {
          if (lifecycle.isTornDown) return
          collectNotification(notification.method, notification.params, false)
        }
      })
    })
  }

  private handleNotification(method: string, params: unknown): void {
    try {
      const identity = turnNotificationIdentitySchema.safeParse(params)
      const tracked = identity.success ? this.turnHandlers.get(identity.data.threadId) : undefined
      const turnId = identity.success ? identity.data.turnId : null
      const requestId =
        tracked !== undefined && tracked.turn.id !== null && tracked.turn.id === turnId
          ? tracked.requestId
          : undefined
      this.notificationHandler?.(method, params, requestId)
    } catch (error) {
      const message = formatCodexConsumerError({
        kind: "notification",
        error,
        redactLogText: this.redactLogText,
      })
      if (this.onLog) this.onLog(message, "error")
      else this.consumerDiagnostics.report({ kind: "notification", error })
    }
    const threadId = notificationThreadId(params)
    if (threadId === null) {
      if (this.turnHandlers.size === 1) {
        this.turnHandlers.values().next().value?.handler(method, params)
      }
      return
    }
    this.turnHandlers.get(threadId)?.handler(method, params)
  }

  private abortInFlightTurns(err: Error): void {
    const aborters = Array.from(this.turnAborters)
    this.turnAborters.clear()
    for (const aborter of aborters) aborter(err)
  }
}

const notificationThreadId = (params: unknown): string | null => {
  if (typeof params !== "object" || params === null || !("threadId" in params)) return null
  return typeof params.threadId === "string" ? params.threadId : null
}

const getTurnErrorMessage = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null || !("message" in error)) return null
  return typeof error.message === "string" ? error.message : null
}

const INITIALIZE_TIMEOUT_MS = 30_000

const COMMAND_OUTPUT_LIMIT_CHARS = 200_000

/** `thread/start` / `thread/resume` are quick metadata round-trips; a hung
 * child must not park `drainTurns` forever with every later message piling
 * up behind it. */
const THREAD_REQUEST_TIMEOUT_MS = 60_000

const STOP_TERM_GRACE_MS = 5_000
const STOP_KILL_GRACE_MS = 5_000

const raceExitOrTimeout = async (
  exit: Promise<void>,
  graceMs: number,
): Promise<"exited" | "timeout"> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exit.then(() => "exited" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), graceMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  // When the timeout wins the underlying request keeps running; a late
  // rejection from it must not surface as an unhandled rejection.
  promise.catch(() => undefined)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CodexRequestTimeoutError(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
