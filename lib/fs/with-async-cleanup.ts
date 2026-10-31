/** Preserve the primary failure when asynchronous cleanup also fails. */
export async function withAsyncCleanup<T>(
  operation: () => T | Promise<T>,
  cleanup: () => void | Promise<void>,
): Promise<T> {
  const capture = async (): Promise<
    { completed: true; value: T } | { completed: false; error: unknown }
  > => {
    try {
      return { completed: true, value: await operation() }
    } catch (error) {
      return { completed: false, error }
    }
  }
  const outcome = await capture()
  try {
    await cleanup()
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
