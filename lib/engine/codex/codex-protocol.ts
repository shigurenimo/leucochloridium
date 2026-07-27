import { jsonRpcIncomingSchema } from "@/engine/codex/codex-schemas"
import { errorMessage } from "@/error-message"

type Pending = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export type CodexNotificationHandler = (method: string, params: unknown) => void

export type CodexLineWriter = (line: string) => void

export type LeucoCodexProtocolProps = {
  writer: CodexLineWriter
  onLog?: (line: string) => void
  maxFrameChars?: number
  logPreviewChars?: number
}

/**
 * Pure NDJSON JSON-RPC framing on top of an injected line writer.
 *
 *  - `request(method, params)` writes a JSON-RPC request and resolves when the
 *    matching response arrives via `feedChunk`.
 *  - `notify(method, params)` writes a JSON-RPC notification (no id, no reply).
 *  - `feedChunk(text)` accepts arbitrary stdout fragments and dispatches every
 *    complete `\n`-terminated line to either a pending request or the
 *    registered notification handler.
 *  - `fail(err)` rejects every in-flight request (used when the underlying
 *    transport dies).
 *
 * Has no dependency on `child_process`; the test harness can call `feedChunk`
 * with synthetic input and inspect what was written through the injected
 * `writer`.
 */
export class LeucoCodexProtocol {
  private readonly writer: CodexLineWriter
  private readonly onLog: (line: string) => void
  private readonly maxFrameChars: number
  private readonly logPreviewChars: number
  private readonly pending = new Map<string | number, Pending>()
  private buffer = ""
  private nextId = 1
  private notificationHandler: CodexNotificationHandler | null = null

  constructor(props: LeucoCodexProtocolProps) {
    this.writer = props.writer
    this.onLog = props.onLog ?? (() => undefined)
    this.maxFrameChars = props.maxFrameChars ?? MAX_CODEX_PROTOCOL_FRAME_CHARS
    this.logPreviewChars = props.logPreviewChars ?? MAX_CODEX_PROTOCOL_LOG_PREVIEW_CHARS
    if (!Number.isSafeInteger(this.maxFrameChars) || this.maxFrameChars < 64) {
      throw new Error("maxFrameChars must be an integer >= 64")
    }
    if (!Number.isSafeInteger(this.logPreviewChars) || this.logPreviewChars < 64) {
      throw new Error("logPreviewChars must be an integer >= 64")
    }
  }

  onNotification(handler: CodexNotificationHandler | null): void {
    this.notificationHandler = handler
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId
    this.nextId += 1
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // `writer` is `child.stdin.write` in production; if stdin is already
      // closed (race with codex exit) it throws synchronously. Without this
      // catch the pending entry would never settle and the awaiting caller
      // would hang until tenant's wall-clock timeout fires.
      try {
        this.writer(`${payload}\n`)
      } catch (err) {
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params })
    try {
      this.writer(`${payload}\n`)
    } catch (err) {
      this.onLog(`[codex notify failed] ${errorMessage(err)}`)
    }
  }

  feedChunk(chunk: string): Error | null {
    this.buffer += chunk

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n")
      if (newlineIndex < 0) break
      const frameError = this.takeFrame(newlineIndex)
      if (frameError !== null) return frameError
    }

    if (this.buffer.length > this.maxFrameChars) {
      return this.failOversizedFrame(this.buffer.length)
    }
    return null
  }

  fail(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private handleLine(line: string): void {
    const json = tryParse(line)
    if (json === undefined) {
      this.onLog(`[codex non-json] ${this.toLogPreview(line)}`)
      return
    }

    const result = jsonRpcIncomingSchema.safeParse(json)
    if (!result.success) {
      this.onLog(`[codex unknown] ${this.toLogPreview(line)}`)
      return
    }

    const msg = result.data
    if ("id" in msg && "method" in msg) {
      this.rejectServerRequest(msg.id, msg.method)
      return
    }

    if ("id" in msg) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if ("error" in msg) {
        pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`))
        return
      }
      pending.resolve(msg.result)
      return
    }

    if (this.notificationHandler) {
      this.notificationHandler(msg.method, msg.params)
    }
  }

  private takeFrame(newlineIndex: number): Error | null {
    if (newlineIndex > this.maxFrameChars) return this.failOversizedFrame(newlineIndex)

    const line = this.buffer.slice(0, newlineIndex).trim()
    this.buffer = this.buffer.slice(newlineIndex + 1)
    if (line.length > 0) this.handleLine(line)
    return null
  }

  private failOversizedFrame(frameChars: number): Error {
    const error = new Error(
      `codex protocol frame exceeded ${this.maxFrameChars} characters (received at least ${frameChars})`,
    )
    this.buffer = ""
    this.fail(error)
    this.onLog(`[codex protocol] ${error.message}`)
    return error
  }

  private toLogPreview(line: string): string {
    if (line.length <= this.logPreviewChars) return line

    const suffix = `… [${line.length} chars]`
    const prefixChars = Math.max(0, this.logPreviewChars - suffix.length)
    return `${line.slice(0, prefixChars)}${suffix}`
  }

  /**
   * codex may send server→client requests (approval prompts etc.). leuco has
   * no terminal to answer them, and silently dropping the frame would leave
   * codex waiting forever — reply with a JSON-RPC error so the turn can fail
   * fast instead of stalling until the tenant wall-clock timeout.
   */
  private rejectServerRequest(id: string | number, method: string): void {
    this.onLog(`[codex server request rejected] ${method} (id ${id})`)
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `leuco cannot answer server request "${method}"` },
    })
    try {
      this.writer(`${payload}\n`)
    } catch (err) {
      this.onLog(`[codex server request reply failed] ${errorMessage(err)}`)
    }
  }
}

const MAX_CODEX_PROTOCOL_FRAME_CHARS = 8 * 1024 * 1024
const MAX_CODEX_PROTOCOL_LOG_PREVIEW_CHARS = 2_000

const tryParse = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
