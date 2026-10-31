import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { recordMaintenanceOperation } from "@/maintenance/record-maintenance-operation"
import { errorDetails } from "@/error-details"
import { errorMessage } from "@/error-message"
import { redactPublicText } from "@/secrets/redact-public-text"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"

export function recordRestartSpawnFailure(
  home: string,
  operation: MaintenanceOperation,
  error: unknown,
): void {
  try {
    recordMaintenanceOperation(
      home,
      {
        ...operation,
        status: "failed",
        updatedAt: Date.now(),
        error: truncateDiagnosticText(
          redactPublicText(`Unable to spawn detached restart worker: ${errorMessage(error)}`),
          4000,
        ),
        causes: errorDetails(error),
      },
      operation.id,
    )
  } catch (recording) {
    throw new AggregateError(
      [error, recording],
      "Restart worker spawn failed and its failure journal could not be saved",
      { cause: error },
    )
  }
}
