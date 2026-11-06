import { CliError } from "@/cli/cli-error"
import type { DaemonLease } from "@/daemon/daemon-lease"
import { getDaemonLeaseId } from "@/daemon/get-daemon-lease-id"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import {
  RESTART_OLD_DAEMON_EXIT_TIMEOUT_MS,
  RESTART_STOP_REQUEST_TIMEOUT_MS,
} from "@/maintenance/restart-worker-limits"

type Props = {
  operation: Pick<MaintenanceOperation, "oldPid" | "oldLeaseId">
  lease: DaemonLease | null
  isAlive: (pid: number) => boolean
  requestStop: (lease: DaemonLease, timeoutMs: number) => Promise<unknown>
  waitForExit: (pid: number, timeoutMs: number) => Promise<void>
  onStopping: () => void
}

type Failure = { cause: unknown }

/**
 * A failed or slow /stop is not terminal: during automatic recovery the old daemon may already be
 * closing its control server, or have released its lease while its process still runs. Only the
 * observed exit of the recorded old daemon lets the worker start a replacement. A recorded
 * oldPidExited does not skip the wait: a daemon records it when it releases ownership, before exit.
 */
export async function stopReplacedDaemon(props: Props): Promise<void> {
  const lease = props.lease
  const operation = props.operation
  if (lease !== null && props.isAlive(lease.pid)) {
    if (lease.pid !== operation.oldPid || getDaemonLeaseId(lease) !== operation.oldLeaseId)
      throw new Error(
        "Daemon identity changed after restart was requested; refusing to stop another process",
      )
    props.onStopping()
    const stopFailure = await props.requestStop(lease, RESTART_STOP_REQUEST_TIMEOUT_MS).then(
      () => null,
      (cause: unknown): Failure => ({ cause }),
    )
    // Another owner replaced the lease, so waiting for the old PID cannot make a restart safe.
    if (stopFailure?.cause instanceof CliError && stopFailure.cause.code === "STATE_CONFLICT")
      throw stopFailure.cause
    await waitForReplacedDaemonExit(props, lease.pid, stopFailure)
    return
  }
  const pid = operation.oldPid
  if (pid === null || !props.isAlive(pid)) return
  props.onStopping()
  await waitForReplacedDaemonExit(props, pid, null)
}

async function waitForReplacedDaemonExit(
  props: Props,
  pid: number,
  stopFailure: Failure | null,
): Promise<void> {
  const exitFailure = await props.waitForExit(pid, RESTART_OLD_DAEMON_EXIT_TIMEOUT_MS).then(
    () => null,
    (cause: unknown): Failure => ({ cause }),
  )
  if (exitFailure === null) return
  const failure = new CliError(
    "STATE_UNCERTAIN",
    "Old daemon is still stopping. No replacement was started.",
    {
      phase: "process-exit",
      pid,
      timeoutMs: RESTART_OLD_DAEMON_EXIT_TIMEOUT_MS,
      stopRequestFailed: stopFailure !== null,
    },
  )
  failure.cause =
    stopFailure === null
      ? exitFailure.cause
      : new AggregateError(
          [exitFailure.cause, stopFailure.cause],
          "Old daemon exit was not observed after its stop request failed",
          { cause: exitFailure.cause },
        )
  throw failure
}
