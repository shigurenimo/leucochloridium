import type { MaintenanceStore } from "@/maintenance/maintenance-store"
import { createMaintenanceObservationError } from "@/maintenance/create-maintenance-observation-error"
import { errorDetails } from "@/error-details"
import { errorMessage } from "@/error-message"
import { redactPublicText } from "@/secrets/redact-public-text"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"

export function recordMaintenanceEventFailure(
  store: MaintenanceStore,
  operationId: string,
  error: unknown,
): boolean {
  const message = truncateDiagnosticText(redactPublicText(errorMessage(error)), 4000)
  try {
    return (
      store.updateOperation(operationId, (current) => ({
        ...current,
        eventLogError: message,
        eventLogCauses: errorDetails(error),
      })) !== null
    )
  } catch (recording) {
    const cause = new AggregateError(
      [error, recording],
      "Maintenance journal was saved but event-failure diagnostics could not be saved",
      { cause: error },
    )
    throw createMaintenanceObservationError(operationId, cause)
  }
}
