import { setImmediate } from "node:timers/promises"
import { awaitAbortableOperation } from "@/await-abortable-operation"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"

type Props = {
  response: Response
  label: string
  signal: AbortSignal
  maxBytes: number
  limitHint?: string
}

/** The request owner cancels the body after this reader releases its lock. */
export async function readBoundedJsonResponse(props: Props): Promise<unknown> {
  const tooLarge = new Error(
    `${props.label} exceeded ${props.maxBytes} bytes${props.limitHint ? `; ${props.limitHint}` : ""}`,
  )
  const declaredLength = Number(props.response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > props.maxBytes) throw tooLarge
  const body = props.response.body
  if (body === null) throw new Error(`${props.label} body is empty`)
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const total = { bytes: 0, text: "", chunksSinceYield: 0 }
  const outcome = await (async (): Promise<
    { completed: true; text: string } | { completed: false; error: unknown }
  > => {
    try {
      while (true) {
        props.signal.throwIfAborted()
        const next = await awaitAbortableOperation(reader.read(), props.signal)
        if (next.done) break
        const chunk = next.value
        if (!(chunk instanceof Uint8Array)) throw new Error(`${props.label}: invalid byte chunk`)
        total.bytes += chunk.byteLength
        if (total.bytes > props.maxBytes) throw tooLarge
        total.chunksSinceYield += 1
        // Already-resolved reads must not starve the request deadline timer.
        if (chunk.byteLength === 0 || total.chunksSinceYield >= 256) {
          total.chunksSinceYield = 0
          await setImmediate()
        }
        total.text += decoder.decode(chunk, { stream: true })
      }
      props.signal.throwIfAborted()
      return {
        completed: true,
        text: total.text + decoder.decode(),
      }
    } catch (error) {
      return { completed: false, error }
    }
  })()
  const text = withSyncCleanup(
    () => {
      if (!outcome.completed) throw outcome.error
      return outcome.text
    },
    () => reader.releaseLock(),
  )
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`${props.label} is not valid JSON`, { cause })
  }
}
