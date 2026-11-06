import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"

/** Recorded daemon PIDs whose exit has not been positively confirmed in the journal. */
export function getRecordedDaemonPids(
  operation: Pick<MaintenanceOperation, "oldPid" | "newPid" | "oldPidExited" | "newPidExited">,
): number[] {
  const pids: number[] = []
  if (operation.oldPid !== null && operation.oldPidExited !== true) pids.push(operation.oldPid)
  if (operation.newPid !== null && operation.newPidExited !== true) pids.push(operation.newPid)
  return pids
}
