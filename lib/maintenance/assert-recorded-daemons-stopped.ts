import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { getRecordedDaemonPids } from "@/maintenance/get-recorded-daemon-pids"
import { CliError } from "@/cli/cli-error"

/** Missing ownership is not evidence that a previously recorded daemon has exited; only a journaled exit confirmation is. */
export function assertRecordedDaemonsStopped(
  operation: Pick<
    MaintenanceOperation,
    "id" | "oldPid" | "newPid" | "oldPidExited" | "newPidExited"
  > | null,
  isAlive: (pid: number) => boolean,
  currentPid?: number,
): void {
  if (operation === null) return
  for (const pid of getRecordedDaemonPids(operation)) {
    if (pid === currentPid || !isAlive(pid)) continue
    throw new CliError(
      "STATE_UNCERTAIN",
      "A daemon PID recorded by maintenance is still alive, but its ownership cannot be verified. Inspect process and maintenance history before retrying.",
      { phase: "identity", pid, operationId: operation.id, executionStarted: false },
    )
  }
}
