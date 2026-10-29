import { errorDetails } from "@/error-details"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import { isProcessAlive } from "@/daemon/daemon-lease"
export function readMaintenance(home: string) {
  try {
    const operation = new NodeMaintenanceStore(home).readOperation()
    if (operation === null) return null
    const workerAlive = operation.workerPid !== null && isProcessAlive(operation.workerPid)
    if (!workerAlive && ["accepted", "stopping", "starting"].includes(operation.status))
      return {
        ...operation,
        recordedStatus: operation.status,
        status: "uncertain",
        workerAlive,
        error:
          operation.error ??
          "Worker exited before a terminal observation was recorded; inspect daemon state, do not assume it stopped",
      }
    return { ...operation, workerAlive }
  } catch (error) {
    return {
      status: "unreadable",
      causes: errorDetails(error),
      error:
        "Maintenance journal is invalid; preserve it and inspect before scheduling another restart",
    }
  }
}
