import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import { assertRecordedDaemonsStopped } from "@/maintenance/assert-recorded-daemons-stopped"
import { readRegularJson } from "@/fs/read-regular-json"
import { CliError } from "@/cli/cli-error"
import { lstatSync, rmSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { withFileLock } from "@/fs/with-file-lock"

const daemonLeaseSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().min(1),
})
export type DaemonLease = z.infer<typeof daemonLeaseSchema>

export function readDaemonLease(home: string): DaemonLease | null {
  const path = join(home, "daemon.json")
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return null
  return daemonLeaseSchema.parse(readRegularJson(path))
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    return true
  }
}

export function acquireDaemonLease(home: string): DaemonLease {
  return withFileLock({ lockPath: join(home, "lifecycle.lock") }, () => {
    const previous = readDaemonLease(home)
    if (previous !== null && isProcessAlive(previous.pid))
      throw new CliError("STATE_CONFLICT", "Leuco is already running or starting; use leuco status")
    assertRecordedDaemonsStopped(
      new NodeMaintenanceStore(home).readOperation(),
      isProcessAlive,
      process.pid,
    )
    const lease = { pid: process.pid, token: randomUUID() }
    rmSync(join(home, "control.sock"), { force: true })
    atomicWriteJson({ path: join(home, "daemon.json"), data: lease, mode: 0o600 })
    return lease
  })
}

export function releaseDaemonLease(home: string, lease: DaemonLease): boolean {
  return withFileLock({ lockPath: join(home, "lifecycle.lock") }, () => {
    const current = readDaemonLease(home)
    if (current === null || current.pid !== lease.pid || current.token !== lease.token) return false
    rmSync(join(home, "control.sock"), { force: true })
    rmSync(join(home, "daemon.json"), { force: true })
    return true
  })
}
