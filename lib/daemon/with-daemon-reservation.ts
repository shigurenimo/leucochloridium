import { acquireDaemonLease, releaseDaemonLease } from "@/daemon/daemon-lease"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"
import { CliError } from "@/cli/cli-error"
import { copyRedactedError } from "@/secrets/copy-redacted-error"
import { errorDetails } from "@/error-details"

export async function withDaemonReservation<T>(
  home: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const reservation = (() => {
    try {
      return acquireDaemonLease(home)
    } catch (cause) {
      if (!(cause instanceof CliError) || cause.code !== "STATE_CONFLICT") throw cause
      const failure = new CliError("STATE_CONFLICT", cause.message, {
        phase: "reservation-acquire",
        executionStarted: false,
        mutationMayHaveOccurred: true,
        causes: errorDetails(cause),
      })
      failure.cause = cause
      throw failure
    }
  })()
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
  const release = { confirmed: false }
  try {
    return withSyncCleanup(
      () => {
        if (!outcome.completed) throw outcome.error
        return outcome.value
      },
      () => {
        if (!releaseDaemonLease(home, reservation))
          throw new Error(
            "Daemon reservation ownership changed; current metadata and control path were preserved",
          )
        release.confirmed = true
      },
    )
  } catch (error) {
    if (release.confirmed) throw error
    const cause = copyRedactedError(error, [reservation.token])
    const failure = new CliError(
      "STATE_UNCERTAIN",
      "Daemon reservation release was not confirmed; the operation may already have changed local state. Inspect leuco status, leuco config show or leuco session list before retrying.",
      {
        phase: "reservation-release",
        reservationPid: reservation.pid,
        operationCompleted: outcome.completed,
        causes: errorDetails(cause),
      },
    )
    failure.cause = cause
    throw failure
  }
}
