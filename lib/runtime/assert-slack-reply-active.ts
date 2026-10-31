import { awaitBoundedCleanup } from "@/await-bounded-cleanup"

export async function assertSlackReplyActive(reply: unknown, signal: AbortSignal): Promise<void> {
  if (!signal.aborted) return
  const failure = signal.reason
  if (reply instanceof Response) {
    try {
      await awaitBoundedCleanup(
        Promise.resolve().then(async () => {
          await reply.body?.cancel(failure)
        }),
        "Cancelled Slack reply disposal",
      )
    } catch (cleanup) {
      throw new AggregateError(
        [failure, cleanup],
        "Slack operation cancelled; response cleanup failed",
        { cause: failure },
      )
    }
  }
  throw failure
}
