import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import type { MaintenanceStore } from "@/maintenance/maintenance-store"
import { CliError } from "@/cli/cli-error"
import { errorDetails } from "@/error-details"

/** An unreadable journal cannot prove that its recorded daemon PIDs have exited. */
export function readMaintenanceOperation(store: MaintenanceStore): MaintenanceOperation | null {
  try {
    return store.readOperation()
  } catch (cause) {
    const failure = new CliError(
      "STATE_UNCERTAIN",
      "Maintenance journal is invalid, so recorded daemon processes cannot be verified as stopped. Preserve maintenance.json and inspect it before retrying.",
      { phase: "maintenance-journal", executionStarted: false, causes: errorDetails(cause) },
    )
    failure.cause = cause
    throw failure
  }
}
