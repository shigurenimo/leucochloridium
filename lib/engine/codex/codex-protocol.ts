import { jsonRpcIncomingSchema } from "@/engine/codex/codex-schemas"
import { errorMessage } from "@/error-message"

type Pending = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

type NotificationHandler = (method: string, params: unknown) => void

type LineWriter = (line: string) => void

type Props = {
  writer: LineWriter
  onLog?: (line: string) => void
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
  private readonly writer: LineWriter
  private readonly onLog: (line: string) => void
  private readonly pending = new Map<number, Pending>()
  private buffer = ""
  private nextId = 1
  private notificationHandler: NotificationHandler | null = null

  constructor(props: Props) {
    this.writer = props.writer
    this.onLog = props.onLog ?? (() => undefined)
  }

  onNotification(handler: NotificationHandler | null): void {
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

  feedChunk(chunk: string): void {
    this.buffer += chunk
    let idx = this.buffer.indexOf("\n")
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line.length > 0) this.handleLine(line)
      idx = this.buffer.indexOf("\n")
    }
  }

  fail(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private handleLine(line: string): void {
    const json = tryParse(line)
    if (json === undefined) {
      this.onLog(`[codex non-json] ${line}`)
      return
    }

    // A server-initiated REQUEST (id + method) must get an answer: the zod
    // union would strip the id and treat it as a notification, and codex
    // would then wait on the reply forever. approval_policy="never" means we
    // never expect these — decline explicitly instead of hanging the child.
    const serverRequestId = extractServerRequestId(json)
    if (serverRequestId !== null) {
      const method = (json as { method: string }).method
      this.onLog(`[codex server-request declined] ${method}`)
      this.respondMethodNotSupported(serverRequestId, method)
      return
    }

    const result = jsonRpcIncomingSchema.safeParse(json)
    if (!result.success) {
      this.onLog(`[codex unknown] ${line}`)
      return
    }

    const msg = result.data
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

  private respondMethodNotSupported(id: number | string, method: string): void {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not supported by leuco client: ${method}` },
    })
    try {
      this.writer(`${payload}\n`)
    } catch (err) {
      this.onLog(`[codex request reply failed] ${errorMessage(err)}`)
    }
  }
}

const extractServerRequestId = (json: unknown): number | string | null => {
  if (typeof json !== "object" || json === null) return null
  if (!("id" in json) || !("method" in json)) return null

  const candidate = json as { id: unknown; method: unknown }
  if (typeof candidate.method !== "string") return null
  if (typeof candidate.id === "number" || typeof candidate.id === "string") return candidate.id
  return null
}

const tryParse = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
