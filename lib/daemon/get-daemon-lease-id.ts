import { createHash } from "node:crypto"
import type { DaemonLease } from "@/daemon/daemon-lease"

/** A non-authenticating identity may be journaled; the control secret must stay private. */
export function getDaemonLeaseId(lease: DaemonLease): string {
  return createHash("sha256").update(lease.token).digest("hex")
}
