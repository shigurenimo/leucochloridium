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

    this.exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`
        protocol.fail(new Error(`codex app-server exited (${reason})`))
        this.child = null
        this.protocol = null
        resolve()
      })
    })

    child.once("error", (err) => {
      protocol.fail(err)
    })

    this.child = child
    this.protocol = protocol

    // Mandatory handshake. codex app-server rejects every other request with
    // `Not initialized` until `initialize` completes. If the request fails
    // (bad CODEX_HOME, codex binary missing capabilities, etc.) we must kill
    // the spawned child here — otherwise the caller's `start()` rejects with
    // no live `LeucoCodexClient` reference to call `stop()` on, leaving a
    // zombie codex process.
    try {
      await protocol.request("initialize", {
        clientInfo: {
          name: this.clientName,
          title: this.clientTitle,
          version: this.clientVersion,
        },
      })
    } catch (err) {
      child.kill("SIGTERM")
      if (this.exitPromise) await this.exitPromise
      throw err
    }
    protocol.notify("initialized")
  }

  async stop(): Promise<void> {
    const child = this.child
    if (child === null) return
    child.stdin.end()
    child.kill("SIGTERM")
    if (this.exitPromise) await this.exitPromise
  }

  async startThread(params: ThreadStartParams): Promise<ThreadStartResult | Error> {
    const protocol = this.protocol
    if (!protocol) return new Error("codex client not started")
    const result = await protocol.request("thread/start", params)
    return threadStartResultSchema.parse(result)
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
      const message = err instanceof Error ? err.message : String(err)
      if (/not found|no such thread|no thread/i.test(message)) return null
      return err instanceof Error ? err : new Error(message)
    }
  }

  startTurn(params: TurnStartParams): Promise<unknown | Error> {
    const protocol = this.protocol
    if (!protocol) return Promise.resolve(new Error("codex client not started"))
    return protocol.request("turn/start", params)
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

      const restore = (): void => {
        this.notificationHandler = previous
        if (previous) protocol.onNotification(previous)
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
          restore()
          const turn = parsed.data.turn
          if (turn.status === "failed") {
            const message = turn.error?.message ?? "turn failed"
            reject(new Error(message))
            return
          }
          const finalText =
            completedTexts.length > 0 ? completedTexts.join("\n\n") : deltas.join("")
          resolve(finalText)
        }
      }

      this.notificationHandler = handler
      protocol.onNotification(handler)

      this.startTurn(params).then((result) => {
        if (result instanceof Error) {
          restore()
          reject(result)
        }
      })
    })
  }
}
