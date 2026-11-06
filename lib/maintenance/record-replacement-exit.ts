import type { MaintenanceStore } from "@/maintenance/maintenance-store"
import { recordDaemonExits } from "@/maintenance/record-daemon-exits"

type LaunchedDaemon = { pid: number | null; exited: boolean }

/**
 * The worker's own child exit event confirms that the replacement is gone, even when it exited
 * before taking ownership and even if the OS has already reused the PID number.
 */
export function recordReplacementExit(
  store: MaintenanceStore,
  launched: LaunchedDaemon | null,
): boolean {
  if (launched === null || !launched.exited) return false
  const pid = launched.pid
  if (pid === null) return false
  return recordDaemonExits(store, (candidate) => candidate === pid)
}
