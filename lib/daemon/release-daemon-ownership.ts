import type { DaemonLease } from "@/daemon/daemon-lease"
import type { MaintenanceStore } from "@/maintenance/maintenance-store"
import { recordDaemonExits } from "@/maintenance/record-daemon-exits"

type Props = {
  lease: DaemonLease
  isCleanupComplete: boolean
  release: (lease: DaemonLease) => boolean
  maintenance: MaintenanceStore
}

/** An incomplete shutdown keeps both the lease and the recorded-PID guard until the process exits. */
export function releaseDaemonOwnership(props: Props): "released" | "retained" | "not-owned" {
  if (!props.isCleanupComplete) return "retained"
  if (!props.release(props.lease)) return "not-owned"
  recordDaemonExits(props.maintenance, (pid) => pid === props.lease.pid)
  return "released"
}
