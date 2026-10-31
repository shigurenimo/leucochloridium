/** Synchronous cleanup cannot erase the primary failure or turn cleanup failure into success. */
export function withSyncCleanup<T>(operation: () => T, cleanup: () => void): T {
  const capture = (): { completed: true; value: T } | { completed: false; error: unknown } => {
    try {
      return { completed: true, value: operation() }
    } catch (error) {
      return { completed: false, error }
    }
  }
  const outcome = capture()
  try {
    cleanup()
  } catch (error) {
    if (!outcome.completed)
      throw new AggregateError([outcome.error, error], "Operation and cleanup both failed", {
        cause: outcome.error,
      })
    throw error
  }
  if (!outcome.completed) throw outcome.error
  return outcome.value
}
