import { readRegularText } from "@/fs/read-regular-text"
import { CliError } from "@/cli/cli-error"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { withFileLock } from "@/fs/with-file-lock"

export const daemonLeaseSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().min(1),
})
export type DaemonLease = z.infer<typeof daemonLeaseSchema>

export function readDaemonLease(home: string): DaemonLease | null {
  const path = join(home, "daemon.json")
  if (!existsSync(path)) return null
  return daemonLeaseSchema.parse(JSON.parse(readRegularText(path)))
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
    const lease = { pid: process.pid, token: randomUUID() }
    atomicWriteJson({ path: join(home, "daemon.json"), data: lease, mode: 0o600 })
    rmSync(join(home, "control.sock"), { force: true })
    return lease
  })
}

export function releaseDaemonLease(home: string, lease: DaemonLease): void {
  withFileLock({ lockPath: join(home, "lifecycle.lock") }, () => {
    if (readDaemonLease(home)?.token !== lease.token) return
    rmSync(join(home, "control.sock"), { force: true })
    rmSync(join(home, "daemon.json"), { force: true })
  })
}
