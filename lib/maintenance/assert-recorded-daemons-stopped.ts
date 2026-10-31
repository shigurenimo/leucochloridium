import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { CliError } from "@/cli/cli-error"

/** Missing ownership is not evidence that a previously recorded daemon has exited. */
export function assertRecordedDaemonsStopped(
  operation: Pick<MaintenanceOperation, "id" | "oldPid" | "newPid"> | null,
  isAlive: (pid: number) => boolean,
  currentPid?: number,
): void {
  for (const pid of [operation?.oldPid, operation?.newPid]) {
    if (pid === null || pid === undefined || pid === currentPid || !isAlive(pid)) continue
    throw new CliError(
      "STATE_UNCERTAIN",
      "A daemon PID recorded by maintenance is still alive, but its ownership cannot be verified. Inspect process and maintenance history before retrying.",
      { phase: "identity", pid, operationId: operation?.id, executionStarted: false },
    )
  }
}
