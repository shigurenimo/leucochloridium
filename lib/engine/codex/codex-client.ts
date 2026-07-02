import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { LeucoCodexProtocol } from "@/engine/codex/codex-protocol"
import {
  agentMessageDeltaSchema,
  itemCompletedSchema,
  threadStartResultSchema,
} from "@/engine/codex/codex-schemas"
import type { ThreadStartResult } from "@/engine/codex/codex-schemas"
import { turnCompletedSchema } from "@/engine/codex/codex-schemas"
import type {
  ThreadResumeParams,
  ThreadStartParams,
  TurnInputItem,
  TurnStartParams,
} from "@/engine/codex/codex-types"
import { errorMessage } from "@/error-message"

type NotificationHandler = (method: string, params: unknown) => void

type Props = {
  bin?: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  onLog?: (line: string) => void
  /**
   * Called for every JSON-RPC notification from codex BEFORE per-turn handlers
   * (`collectTurn`'s temporary handler chains to whatever was set previously).
   * Useful for broadcasting to the structured event bus.
   */
  onAnyNotification?: NotificationHandler
  clientName?: string
  clientTitle?: string
  clientVersion?: string
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

  private child: ChildProcessWithoutNullStreams | null = null
  private protocol: LeucoCodexProtocol | null = null
  private notificationHandler: NotificationHandler | null = null
  private exitPromise: Promise<void> | null = null
  /**
   * In-flight `collectTurnInternal` rejecters. The protocol layer rejects
   * pending JSON-RPC requests on transport failure, but turn collection
   * waits on streamed notifications instead — without this registry a
   * codex crash mid-turn would hang the awaiting Promise forever.
   */
  private readonly turnAborters = new Set<(err: Error) => void>()

  constructor(props: Props = {}) {
    this.bin = props.bin ?? "codex"
    this.args = props.args ?? ["app-server"]
    this.cwd = props.cwd
    this.env = props.env
    this.onLog = props.onLog
    this.clientName = props.clientName ?? "leuco"
    this.clientTitle = props.clientTitle ?? "leucochloridium"
    this.clientVersion = props.clientVersion ?? "0.1.0"
    if (props.onAnyNotification !== undefined) {
      this.notificationHandler = props.onAnyNotification
    }
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
    if (this.protocol) this.protocol.onNotification(handler)
  }

  isRunning(): boolean {
    return this.child !== null
  }

  async start(): Promise<void> {
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
    })
    if (this.notificationHandler) protocol.onNotification(this.notificationHandler)

    child.stdout.on("data", (chunk: string) => {
      protocol.feedChunk(chunk)
    })

    child.stderr.on("data", (chunk: string) => {
      if (!this.onLog) return
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) this.onLog(line)
      }
    })

    let settleExit: () => void = () => undefined
    this.exitPromise = new Promise((resolve) => {
      settleExit = resolve
      child.once("exit", (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`
        const exitError = new Error(`codex app-server exited (${reason})`)
        protocol.fail(exitError)
        this.abortInFlightTurns(exitError)
        this.child = null
        this.protocol = null
        resolve()
      })
    })

    child.once("error", (err) => {
      protocol.fail(err)
      this.abortInFlightTurns(err)
      // A spawn failure (ENOENT etc.) never emits `exit`, so without this the
      // dead client stays "running" forever: isRunning() true blocks the
      // tenant's respawn path and stop() waits a full kill-escalation cycle.
      if (child.pid === undefined) {
        this.child = null
        this.protocol = null
        settleExit()
      }
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
      child.kill("SIGTERM")
      await this.waitForExitOrEscalate(child)
      throw err
    }
    protocol.notify("initialized")
  }

  async stop(): Promise<void> {
    const child = this.child
    if (child === null) return
    child.stdin.end()
    child.kill("SIGTERM")
    await this.waitForExitOrEscalate(child)
  }

  private async waitForExitOrEscalate(child: ChildProcessWithoutNullStreams): Promise<void> {
    const exit = this.exitPromise
    if (!exit) return

    const termRace = await Promise.race([
      exit.then(() => "exited" as const),
      sleep(STOP_TERM_GRACE_MS).then(() => "timeout" as const),
    ])
    if (termRace === "exited") return

    child.kill("SIGKILL")
    await Promise.race([exit, sleep(STOP_KILL_GRACE_MS)])
  }

  async startThread(params: ThreadStartParams): Promise<ThreadStartResult | Error> {
    const protocol = this.protocol
    if (!protocol) return new Error("codex client not started")
    // Both `protocol.request` (rejects on JSON-RPC error) and `parse` (throws
    // on schema drift) need to fold into the `| Error` contract that every
    // other method honours; otherwise the rejection becomes an unhandled
    // rejection in the engine layer.
    try {
      const result = await protocol.request("thread/start", params)
      return threadStartResultSchema.parse(result)
    } catch (err) {
      return err instanceof Error ? err : new Error(errorMessage(err))
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
    if (!protocol) return new Error("codex client not started")
    try {
      const result = await protocol.request("thread/resume", params)
      return threadStartResultSchema.parse(result)
    } catch (err) {
      const message = errorMessage(err)
      if (/not found|no such thread|no thread/i.test(message)) return null
      return err instanceof Error ? err : new Error(message)
    }
  }

  async startTurn(params: TurnStartParams): Promise<unknown | Error> {
    const protocol = this.protocol
    if (!protocol) return new Error("codex client not started")
    try {
      return await protocol.request("turn/start", params)
    } catch (err) {
      return err instanceof Error ? err : new Error(errorMessage(err))
    }
  }

  /**
   * Send a single text-input turn and resolve when it completes. Returns the
   * concatenated assistant text — preferring `item/completed` agentMessage
   * text, falling back to streamed `item/agentMessage/delta`.
   */
  runTextTurn(threadId: string, text: string, cwd?: string): Promise<string | Error> {
    const input: TurnInputItem[] = [{ type: "text", text }]
    return this.collectTurn({ threadId, input, cwd })
  }

  private async collectTurn(params: TurnStartParams): Promise<string | Error> {
    const protocol = this.protocol
    if (!protocol) return new Error("codex client not started")
    try {
      return await this.collectTurnInternal(protocol, params)
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err))
    }
  }

  private collectTurnInternal(
    protocol: LeucoCodexProtocol,
    params: TurnStartParams,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const deltas: string[] = []
      const completedTexts: string[] = []
      const previous = this.notificationHandler

      const aborter = (err: Error): void => {
        teardown()
        reject(err)
      }

      const teardown = (): void => {
        this.notificationHandler = previous
        // Always restore (even to null) — leaving the turn handler installed
        // would keep appending deltas of later turns to this settled promise's
        // arrays.
        protocol.onNotification(previous)
        this.turnAborters.delete(aborter)
      }

      const handler: NotificationHandler = (method, raw) => {
        if (previous) previous(method, raw)

        if (method === "item/agentMessage/delta") {
          const parsed = agentMessageDeltaSchema.safeParse(raw)
          if (parsed.success) deltas.push(parsed.data.delta)
          return
        }

        if (method === "item/completed") {
          const parsed = itemCompletedSchema.safeParse(raw)
          if (
            parsed.success &&
            parsed.data.item.type === "agentMessage" &&
            typeof parsed.data.item.text === "string"
          ) {
            completedTexts.push(parsed.data.item.text)
          }
          return
        }

        if (method === "turn/completed") {
          const parsed = turnCompletedSchema.safeParse(raw)
          if (!parsed.success) return
          teardown()
          const turn = parsed.data.turn
          if (turn.status === "failed") {
            const message = turn.error?.message ?? "turn failed"
            reject(new Error(message))
            return
          }
          if (turn.status === "interrupted") {
            // Partial text from an interrupted turn is not a completed answer;
            // surfacing it as success would let a half-formed reply flow on.
            reject(new Error(turn.error?.message ?? "turn interrupted before completion"))
            return
          }
          const finalText =
            completedTexts.length > 0 ? completedTexts.join("\n\n") : deltas.join("")
          resolve(finalText)
        }
      }

      this.notificationHandler = handler
      protocol.onNotification(handler)
      this.turnAborters.add(aborter)

      // `startTurn` always resolves (errors are folded into `| Error`), so a
      // single `.then` is enough — settling here rejects the outer promise
      // when codex never sends `turn/completed`. Without this `runTextTurn`
      // would hang until the tenant's wall-clock timeout kicks in.
      this.startTurn(params).then((result) => {
        if (result instanceof Error) {
          teardown()
          reject(result)
        }
      })
    })
  }

  private abortInFlightTurns(err: Error): void {
    const aborters = Array.from(this.turnAborters)
    this.turnAborters.clear()
    for (const aborter of aborters) aborter(err)
  }
}

const INITIALIZE_TIMEOUT_MS = 30_000

const STOP_TERM_GRACE_MS = 5_000
const STOP_KILL_GRACE_MS = 5_000

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
