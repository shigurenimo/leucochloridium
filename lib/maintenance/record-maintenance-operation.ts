import { createMaintenanceObservationError } from "@/maintenance/create-maintenance-observation-error"
import { chmodSync, existsSync } from "node:fs"
import { join } from "node:path"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { errorFromDetails } from "@/error-from-details"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"
import { recordMaintenanceEventFailure } from "@/maintenance/record-maintenance-event-failure"
import { redactPublicText } from "@/secrets/redact-public-text"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"
import { MAX_DIAGNOSTIC_MESSAGE_CHARACTERS } from "@/diagnostic-limits"

/** The journal is authoritative even if the secondary event database fails. */
export function recordMaintenanceOperation(
  home: string,
  operation: MaintenanceOperation,
  expectedId?: string,
): boolean {
  const store = new NodeMaintenanceStore(home)
  const safe = {
    ...operation,
    error:
      operation.error === null
        ? null
        : truncateDiagnosticText(
            redactPublicText(operation.error),
            MAX_DIAGNOSTIC_MESSAGE_CHARACTERS,
          ),
  }
  const committed =
    expectedId === undefined
      ? (() => {
          store.writeOperation(safe)
          return safe
        })()
      : store.updateOperation(expectedId, (current) => ({
          ...safe,
          ...(current.eventLogError === undefined ? {} : { eventLogError: current.eventLogError }),
          ...(current.eventLogCauses === undefined
            ? {}
            : { eventLogCauses: current.eventLogCauses }),
        }))
  if (committed === null) return false
  try {
    const log = new LeucoEventLog({ eventLogPath: join(home, "events.db"), diagnosticOutput: null })
    withSyncCleanup(
      () => {
        log.append({
          ts: operation.updatedAt,
          type: "maintenance",
          requestId: operation.id,
          operationId: operation.id,
          status: operation.status,
          workerPid: operation.workerPid,
          oldPid: operation.oldPid,
          newPid: operation.newPid,
          error: committed.error,
        })
        const health = log.getHealth()
        if (health.lastWriteFailed)
          throw health.lastPersistError === null
            ? new Error("Event persistence failed")
            : errorFromDetails(health.lastPersistError.causes)
      },
      () => log.close(),
    )
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = join(home, `events.db${suffix}`)
      if (existsSync(path)) chmodSync(path, 0o600)
    }
  } catch (error) {
    return recordMaintenanceEventFailure(store, operation.id, error)
  }
  if (committed.eventLogError !== undefined && committed.eventLogError !== null) {
    try {
      return (
        store.updateOperation(operation.id, (current) => ({ ...current, eventLogError: null })) !==
        null
      )
    } catch (cause) {
      throw createMaintenanceObservationError(
        operation.id,
        new Error("Maintenance events recovered, but the recovery annotation could not be saved", {
          cause,
        }),
      )
    }
  }
  return true
}
