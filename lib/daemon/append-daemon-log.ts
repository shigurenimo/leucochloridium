import { openDaemonLog } from "@/daemon/open-daemon-log"
import { closeSync, appendFileSync, existsSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"

export function appendDaemonLog(home: string, line: string): boolean {
  const path = join(home, "daemon.log")
  try {
    if (existsSync(path) && statSync(path).size >= 4 * 1024 * 1024) {
      for (const index of [2, 1])
        if (existsSync(`${path}.${index}`)) renameSync(`${path}.${index}`, `${path}.${index + 1}`)
      renameSync(path, `${path}.1`)
    }
    const descriptor = openDaemonLog(home)
    try {
      appendFileSync(descriptor, `${new Date().toISOString()} ${line.slice(0, 16000)}\n`)
    } finally {
      closeSync(descriptor)
    }
    return true
  } catch {
    process.stderr.write(
      "leuco: text log persistence failed; inspect event-log health and filesystem space/permissions\n",
    )
    return false
  }
}
