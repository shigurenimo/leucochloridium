import type { MaintenanceStore } from "@/maintenance/maintenance-store"
import { createMaintenanceObservationError } from "@/maintenance/create-maintenance-observation-error"
import { errorDetails } from "@/error-details"
import { errorMessage } from "@/error-message"
import { toPublicDiagnosticMessage } from "@/to-public-diagnostic-message"

export function recordMaintenanceEventFailure(
  store: MaintenanceStore,
  operationId: string,
  error: unknown,
): boolean {
  const message = toPublicDiagnosticMessage(errorMessage(error))
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
