import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { errorMessage } from "@/error-message"

/**
 * Cancel the body within the cleanup bound. Given the failure that made the
 * body unwanted, a cleanup failure is joined to it instead of replacing it.
 */
export async function cancelSlackResponseBody(
  response: Response | null,
  failure?: { error: unknown },
): Promise<void> {
  try {
    await awaitBoundedCleanup(
      Promise.resolve().then(async () => {
        await response?.body?.cancel()
      }),
      "Slack response cancellation",
    )
  } catch (cleanup) {
    if (failure === undefined) throw cleanup
    throw new AggregateError(
      [failure.error, cleanup],
      `${errorMessage(failure.error)}; response cleanup failed`,
      { cause: failure.error },
    )
  }
}
