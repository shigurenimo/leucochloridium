/** Cancellation and cleanup callbacks can themselves hang; no cleanup step may wait indefinitely. */
export async function awaitBoundedCleanup<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = 1000,
): Promise<T> {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(
    () => expired.reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  )
  try {
    return await Promise.race([operation, expired.promise])
  } finally {
    clearTimeout(timer)
  }
}
