import { openSync, writeFileSync, fsyncSync, closeSync } from "node:fs"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"

export function writeStateBackup(path: string, content: Uint8Array): void {
  const descriptor = openSync(path, "wx", 0o600)
  withSyncCleanup(
    () => {
      writeFileSync(descriptor, content)
      fsyncSync(descriptor)
    },
    () => closeSync(descriptor),
  )
}
