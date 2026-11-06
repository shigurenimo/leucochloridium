import { chmodSync, existsSync } from "node:fs"
import { join } from "node:path"

export function restrictEventLogFiles(home: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = join(home, `events.db${suffix}`)
    if (existsSync(path)) chmodSync(path, 0o600)
  }
}
