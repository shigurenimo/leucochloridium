import { chmodSync, existsSync } from "node:fs"
import { join } from "node:path"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { errorMessage } from "@/error-message"
import { redactPublicText } from "@/secrets/redact-public-text"

/** The journal is authoritative even if the secondary event database fails. */
export function recordMaintenanceOperation(
  home: string,
  operation: MaintenanceOperation,
  expectedId?: string,
): boolean {
  const store = new NodeMaintenanceStore(home)
  if (expectedId === undefined) store.writeOperation(operation)
  else if (store.updateOperation(expectedId, () => operation) === null) return false
  try {
    const log = new LeucoEventLog({ eventLogPath: join(home, "events.db") })
    try {
      log.append({
        ts: operation.updatedAt,
        type: "maintenance",
        requestId: operation.id,
        operationId: operation.id,
        status: operation.status,
        workerPid: operation.workerPid,
        oldPid: operation.oldPid,
        newPid: operation.newPid,
        error: operation.error,
      })
      if (log.getHealth().lastWriteFailed)
        throw new Error(log.getHealth().lastPersistError?.message ?? "Event persistence failed")
    } finally {
      log.close()
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = join(home, `events.db${suffix}`)
      if (existsSync(path)) chmodSync(path, 0o600)
    }
  } catch (error) {
    const message = redactPublicText(errorMessage(error)).slice(0, 4000)
    store.updateOperation(operation.id, (current) => ({ ...current, eventLogError: message }))
    process.stderr.write(
      `leuco: maintenance event persistence failed: ${message}; progress remains in maintenance.json\n`,
    )
  }
  return true
}
