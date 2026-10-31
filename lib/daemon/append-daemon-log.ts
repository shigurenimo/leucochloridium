import { openDaemonLog } from "@/daemon/open-daemon-log"
import { closeSync, appendFileSync, existsSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"
import { formatLogLine } from "@/format-log-line"

export function appendDaemonLog(home: string, line: string): void {
  const path = join(home, "daemon.log")
  if (existsSync(path) && statSync(path).size >= 4 * 1024 * 1024) {
    for (const index of [2, 1])
      if (existsSync(`${path}.${index}`)) renameSync(`${path}.${index}`, `${path}.${index + 1}`)
    renameSync(path, `${path}.1`)
  }
  const descriptor = openDaemonLog(home)
  withSyncCleanup(
    () => appendFileSync(descriptor, `${new Date().toISOString()} ${formatLogLine(line)}\n`),
    () => closeSync(descriptor),
  )
}
