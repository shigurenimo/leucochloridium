import { openSync, fstatSync, closeSync, constants, fchmodSync } from "node:fs"
import { join } from "node:path"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"
export function openDaemonLog(home: string): number {
  const descriptor = openSync(
    join(home, "daemon.log"),
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NONBLOCK |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error("Daemon log must be a regular file, never a pipe/device")
    fchmodSync(descriptor, 0o600)
    return descriptor
  } catch (error) {
    return withSyncCleanup(
      (): never => {
        throw error
      },
      () => closeSync(descriptor),
    )
  }
}
