import type { MaintenanceStore } from "@/maintenance/maintenance-store"

/**
 * Persists positive exit observations for the journal's oldPid/newPid so later PID reuse is not
 * mistaken for a live recorded daemon. Best-effort: a missing confirmation only keeps the
 * recorded-PID guard closed, so a failed write must not fail the observed shutdown or startup.
 */
export function recordDaemonExits(
  store: MaintenanceStore,
  isExited: (pid: number) => boolean,
): boolean {
  try {
    const observed = store.readOperation()
    if (observed === null) return false
    const oldPid =
      observed.oldPid !== null && observed.oldPidExited !== true && isExited(observed.oldPid)
        ? observed.oldPid
        : null
    const newPid =
      observed.newPid !== null && observed.newPidExited !== true && isExited(observed.newPid)
        ? observed.newPid
        : null
    if (oldPid === null && newPid === null) return false
    return (
      store.updateOperation(observed.id, (current) => ({
        ...current,
        ...(oldPid !== null && current.oldPid === oldPid ? { oldPidExited: true } : {}),
        ...(newPid !== null && current.newPid === newPid ? { newPidExited: true } : {}),
      })) !== null
    )
  } catch {
    return false
  }
}
