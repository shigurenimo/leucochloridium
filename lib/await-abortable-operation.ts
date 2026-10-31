/** Observe late settlement while allowing cancellation to finish waiting immediately. */
export async function awaitAbortableOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => aborted.reject(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    return await Promise.race([aborted.promise, operation])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}
