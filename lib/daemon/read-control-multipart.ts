import {
  MAX_CONTROL_MULTIPART_BYTES,
  CONTROL_MULTIPART_RECEIVE_TIMEOUT_MS,
} from "@/daemon/control-input-limits"
import { setImmediate } from "node:timers/promises"
import { awaitAbortableOperation } from "@/await-abortable-operation"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { withAsyncCleanup } from "@/fs/with-async-cleanup"
import { CliError } from "@/cli/cli-error"

export async function readControlMultipart(request: Request) {
  const controller = new AbortController()
  const signal = AbortSignal.any([request.signal, controller.signal])
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `Control multipart receive timed out after ${CONTROL_MULTIPART_RECEIVE_TIMEOUT_MS}ms`,
        ),
      ),
    CONTROL_MULTIPART_RECEIVE_TIMEOUT_MS,
  )
  try {
    const body = request.body
    if (body === null) throw new Error("Control multipart body is empty")
    const reader = body.getReader()
    const state = { done: false, bytes: 0, chunks: 0 }
    return await withAsyncCleanup(
      async () => {
        const declared = Number(request.headers.get("content-length"))
        if (Number.isFinite(declared) && declared > MAX_CONTROL_MULTIPART_BYTES)
          throw new Error(`Control multipart exceeds ${MAX_CONTROL_MULTIPART_BYTES} bytes`)
        const bounded = new ReadableStream<Uint8Array>({
          async pull(output) {
            signal.throwIfAborted()
            const next = await awaitAbortableOperation(reader.read(), signal)
            if (next.done) {
              state.done = true
              output.close()
              return
            }
            if (!(next.value instanceof Uint8Array)) throw new Error("Invalid multipart byte chunk")
            state.bytes += next.value.byteLength
            if (state.bytes > MAX_CONTROL_MULTIPART_BYTES)
              throw new Error(`Control multipart exceeds ${MAX_CONTROL_MULTIPART_BYTES} bytes`)
            state.chunks += 1
            if (next.value.byteLength === 0 || state.chunks >= 256) {
              state.chunks = 0
              await setImmediate()
            }
            signal.throwIfAborted()
            output.enqueue(next.value)
          },
        })
        return await awaitAbortableOperation(
          new Response(bounded, { headers: request.headers }).formData(),
          signal,
        )
      },
      async () => {
        await withAsyncCleanup(
          async () => {
            if (!state.done)
              await awaitBoundedCleanup(
                reader.cancel(signal.reason),
                "Control multipart body cancellation",
              )
          },
          () => reader.releaseLock(),
        )
      },
    )
  } catch (error) {
    const failure = new CliError(
      "USAGE",
      "Control multipart body was not accepted before execution; inspect causes",
      { phase: "control-body", executionStarted: false },
    )
    failure.cause = error
    throw failure
  } finally {
    clearTimeout(timer)
  }
}
