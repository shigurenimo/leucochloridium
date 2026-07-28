import { spawn } from "node:child_process"
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

type NotificationHandler = (method: string, params: unknown) => void

type BufferedNotification = {
  method: string
  params: unknown
}

type ActiveTurn = {
  id: string | null
}

export type LeucoCodexClientProps = {
  bin?: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  onLog?: (line: string) => void
  /**
   * Called for every JSON-RPC notification from codex BEFORE per-turn handlers
   * (`collectTurn`'s temporary handler chains to whatever was set previously).
   * Useful for broadcasting to the structured event journal.
   */
  onAnyNotification?: NotificationHandler
  clientName?: string
  clientTitle?: string
  clientVersion?: string
  commandOutputLimitChars?: number
  threadRequestTimeoutMs?: number
  protocolMaxFrameChars?: number
  protocolLogPreviewChars?: number
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
  private readonly onLog: ((line: string) => void) | undefined
  private readonly clientName: string
  private readonly clientTitle: string
  private readonly clientVersion: string
  private readonly commandOutputLimitChars: number
  private readonly threadRequestTimeoutMs: number
  private readonly protocolMaxFrameChars: number | undefined
  private readonly protocolLogPreviewChars: number | undefined

  private child: ChildProcessWithoutNullStreams | null = null
  private protocol: LeucoCodexProtocol | null = null
  private notificationHandler: NotificationHandler | null = null
  private readonly turnHandlers = new Map<string, NotificationHandler>()
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
    this.args = props.args ?? ["app-server"]
    this.cwd = props.cwd
    this.env = props.env
    this.onLog = props.onLog
    this.clientName = props.clientName ?? "leuco"
    this.clientTitle = props.clientTitle ?? "leucochloridium"
    this.clientVersion = props.clientVersion ?? "0.1.0"
    this.commandOutputLimitChars = props.commandOutputLimitChars ?? COMMAND_OUTPUT_LIMIT_CHARS
    this.threadRequestTimeoutMs = props.threadRequestTimeoutMs ?? THREAD_REQUEST_TIMEOUT_MS
    this.protocolMaxFrameChars = props.protocolMaxFrameChars
    this.protocolLogPreviewChars = props.protocolLogPreviewChars
    if (props.onAnyNotification !== undefined) {
      this.notificationHandler = props.onAnyNotification
    }
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  isRunning(): boolean {
    return this.child !== null && this.protocol !== null
  }

  async start(): Promise<void> {
    const transportFailurePromise = this.transportFailurePromise
    if (transportFailurePromise !== null) await transportFailurePromise
    if (this.child !== null) return

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
    })
    protocol.onNotification((method, params) => this.handleNotification(method, params))

    child.stdout.on("data", (chunk: string) => {
      if (this.protocol !== protocol) return

      const frameError = protocol.feedChunk(chunk)
      if (frameError !== null) void this.failTransport(child, protocol, frameError)
    })

    child.stderr.on("data", (chunk: string) => {
      if (!this.onLog) return
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) this.onLog(line)
      }
    })

    // A write racing the pipe closing surfaces asynchronously as a stream
    // `error` event; without a listener Node turns it into an
    // uncaughtException that takes the whole daemon down with it.
    child.stdin.on("error", (err: Error) => {
      if (this.onLog) this.onLog(`[codex stdin] ${errorMessage(err)}`)
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
        this.onLog?.(`[codex] app-server exited (${reason})`)
        settle(new Error(`codex app-server exited (${reason})`))
      })

      // A failed spawn (binary missing, EACCES) emits `error` and never
      // `exit`; `child.pid` stays undefined in that case. Settling here is
      // what keeps `isRunning()` truthful — otherwise the dead child sticks
      // around forever and the project runtime never respawns. When `pid` exists the
      // process may still be alive (e.g. a kill failure), so only the
      // in-flight work is failed.
      child.once("error", (err) => {
        this.onLog?.(`[codex] app-server error: ${errorMessage(err)}`)
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
            name: this.clientName,
            title: this.clientTitle,
            version: this.clientVersion,
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
    protocol.notify("initialized")
    this.onLog?.(`[codex] app-server ready (pid=${child.pid ?? "unknown"})`)
  }

  async stop(): Promise<void> {
    const transportFailurePromise = this.transportFailurePromise
    if (transportFailurePromise !== null) await transportFailurePromise

    const child = this.child
    if (child === null) return
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
        if (this.child === child) this.child = null
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
      if (/not found|no such thread|no thread/i.test(error.message)) return null
      return error
    }
  }

  async startTurn(params: TurnStartParams): Promise<TurnStartResult | Error> {
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
  runTextTurn(
    threadId: string,
    text: string,
    options?: string | CodexTurnOptions,
  ): Promise<string | Error> {
    const input: TurnInputItem[] = [{ type: "text", text }]
    const cwd = typeof options === "string" ? options : options?.cwd
    const onActivity = typeof options === "string" ? undefined : options?.onActivity
    return this.collectTurn({ threadId, input, cwd }, onActivity)
  }

  private async collectTurn(
    params: TurnStartParams,
    onActivity?: (method: string) => void,
  ): Promise<string | Error> {
    const protocol = this.protocol
    if (!protocol) return new Error("codex client not started")
    try {
      return await this.collectTurnInternal(protocol, params, onActivity)
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err))
    }
  }

  private collectTurnInternal(
    protocol: LeucoCodexProtocol,
    params: TurnStartParams,
    onActivity?: (method: string) => void,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const deltas: string[] = []
      const legacyCompletedTexts: string[] = []
      const finalTexts: string[] = []
      const phaseState = { hasExplicitAgentMessagePhase: false }
      const bufferedNotifications: BufferedNotification[] = []
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
        if (this.turnHandlers.get(params.threadId) === handler) {
          this.turnHandlers.delete(params.threadId)
        }
        this.turnAborters.delete(aborter)
      }

      const processNotification = (method: string, raw: unknown, canBuffer: boolean): void => {
        if (method === "item/agentMessage/delta") {
          const parsed = agentMessageDeltaSchema.safeParse(raw)
          if (!parsed.success || parsed.data.threadId !== params.threadId) return
          if (activeTurn.id === null) {
            if (canBuffer) bufferedNotifications.push({ method, params: raw })
            return
          }
          if (parsed.data.turnId === activeTurn.id) deltas.push(parsed.data.delta)
          return
        }

        if (method === "item/commandExecution/outputDelta") {
          const parsed = commandExecutionOutputDeltaSchema.safeParse(raw)
          if (!parsed.success) return
          const identity = turnNotificationIdentitySchema.safeParse(raw)
          if (!identity.success || identity.data.threadId !== params.threadId) return
          if (activeTurn.id === null) {
            if (canBuffer) bufferedNotifications.push({ method, params: raw })
            return
          }
          const turnId = "turnId" in identity.data ? identity.data.turnId : identity.data.turn.id
          if (turnId !== activeTurn.id) return

          commandOutputState.chars += parsed.data.delta.length
          if (commandOutputState.chars <= this.commandOutputLimitChars) return

          const item = parsed.data.itemId ? ` from ${parsed.data.itemId}` : ""
          const err = new Error(
            `codex command output exceeded ${this.commandOutputLimitChars} chars${item}`,
          )
          teardown()
          void this.stop().then(
            () => reject(err),
            () => reject(err),
          )
          return
        }

        if (method === "item/completed") {
          const parsed = itemCompletedSchema.safeParse(raw)
          if (!parsed.success || parsed.data.threadId !== params.threadId) return
          if (activeTurn.id === null) {
            if (canBuffer) bufferedNotifications.push({ method, params: raw })
            return
          }
          if (
            parsed.data.turnId === activeTurn.id &&
            parsed.data.item.type === "agentMessage" &&
            typeof parsed.data.item.text === "string"
          ) {
            if (typeof parsed.data.item.phase === "string") {
              phaseState.hasExplicitAgentMessagePhase = true
            } else {
              legacyCompletedTexts.push(parsed.data.item.text)
            }
            if (parsed.data.item.phase === "final_answer") {
              finalTexts.push(parsed.data.item.text)
            }
          }
          return
        }

        if (method === "turn/completed") {
          const parsed = turnCompletedSchema.safeParse(raw)
          if (!parsed.success) {
            const identity = turnCompletedIdentitySchema.safeParse(raw)
            if (!identity.success || identity.data.threadId !== params.threadId) return
            if (activeTurn.id === null) {
              if (canBuffer) bufferedNotifications.push({ method, params: raw })
              return
            }
            if (identity.data.turn.id !== activeTurn.id) return

            teardown()
            reject(new Error(`invalid turn/completed: ${parsed.error.message}`))
            return
          }
          if (parsed.data.threadId !== params.threadId) return
          if (activeTurn.id === null) {
            if (canBuffer) bufferedNotifications.push({ method, params: raw })
            return
          }
          if (parsed.data.turn.id !== activeTurn.id) return

          teardown()
          const turn = parsed.data.turn
          if (turn.status !== "completed") {
            const message =
              getTurnErrorMessage(turn.error) ?? `codex turn ${turn.id} ${turn.status}`
            reject(new Error(message))
            return
          }
          const finalText =
            finalTexts.length > 0
              ? finalTexts.join("\n\n")
              : phaseState.hasExplicitAgentMessagePhase
                ? ""
                : legacyCompletedTexts.length > 0
                  ? legacyCompletedTexts.join("\n\n")
                  : deltas.join("")
          resolve(finalText)
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
        const turnId = "turnId" in parsed.data ? parsed.data.turnId : parsed.data.turn.id
        if (turnId === activeTurn.id) signalActivity(method)
      }

      const handler: NotificationHandler = (method, raw) => {
        noteActivity(method, raw)
        processNotification(method, raw, true)
      }

      this.turnHandlers.set(params.threadId, handler)
      this.turnAborters.add(aborter)

      // `startTurn` always resolves (errors are folded into `| Error`), so a
      // single `.then` is enough — settling here rejects the outer promise
      // when codex never sends `turn/completed`. Without this `runTextTurn`
      // would hang until the project runtime's wall-clock timeout kicks in.
      void this.startTurn(params).then((result) => {
        if (result instanceof Error) {
          teardown()
          reject(result)
          return
        }

        activeTurn.id = result.turn.id
        signalActivity("turn/start")
        const buffered = bufferedNotifications.splice(0)
        for (const notification of buffered) {
          if (lifecycle.isTornDown) return
          processNotification(notification.method, notification.params, false)
        }
      })
    })
  }

  private handleNotification(method: string, params: unknown): void {
    this.notificationHandler?.(method, params)
    const threadId = notificationThreadId(params)
    if (threadId === null) {
      if (this.turnHandlers.size === 1) {
        this.turnHandlers.values().next().value?.(method, params)
      }
      return
    }
    this.turnHandlers.get(threadId)?.(method, params)
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
