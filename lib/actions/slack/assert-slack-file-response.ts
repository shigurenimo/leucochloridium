import { awaitBoundedCleanup } from "@/await-bounded-cleanup"

export async function assertSlackFileResponse(response: Response): Promise<void> {
  if (response.ok) return

  const failure = new Error(`Slack file download failed: HTTP ${response.status}`)
  try {
    await awaitBoundedCleanup(
      Promise.resolve().then(async () => {
        await response.body?.cancel()
      }),
      "failed response cancellation",
    )
  } catch (cleanup) {
    throw new AggregateError([failure, cleanup], `${failure.message}; response cleanup failed`, {
      cause: failure,
    })
  }
  throw failure
}
