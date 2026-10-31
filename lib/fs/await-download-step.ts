import { awaitAbortableOperation } from "@/await-abortable-operation"

/** Reject even when the supplied operation ignores cancellation; always observe its eventual result. */
export async function awaitDownloadStep<T>(
  operation: Promise<T>,
  controller: AbortController,
  idleTimeoutMs: number,
): Promise<T> {
  const timer = setTimeout(
    () => controller.abort(new Error(`download timed out after ${idleTimeoutMs}ms without data`)),
    idleTimeoutMs,
  )
  try {
    return await awaitAbortableOperation(operation, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}
