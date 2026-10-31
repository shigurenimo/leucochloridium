import { awaitAbortableOperation } from "@/await-abortable-operation"

export async function awaitAbortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const delayed = Promise.withResolvers<void>()
  const timer = setTimeout(() => delayed.resolve(), milliseconds)
  try {
    if (signal === undefined) await delayed.promise
    else await awaitAbortableOperation(delayed.promise, signal)
  } finally {
    clearTimeout(timer)
  }
}
