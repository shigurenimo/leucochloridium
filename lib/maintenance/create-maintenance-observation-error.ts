import { CliError } from "@/cli/cli-error"
import { errorDetails } from "@/error-details"

export function createMaintenanceObservationError(operationId: string, cause: unknown): CliError {
  const failure = new CliError(
    "STATE_UNCERTAIN",
    "Maintenance journal was saved, but its event-persistence diagnostics could not be updated. Inspect maintenance status before retrying.",
    {
      phase: "maintenance-observability",
      operationId,
      journalWritten: true,
      causes: errorDetails(cause),
    },
  )
  failure.cause = cause
  return failure
}
