import { readRegularJson } from "@/fs/read-regular-json"
import { lstatSync } from "node:fs"
import { join } from "node:path"
import { MaintenanceStore } from "@/maintenance/maintenance-store"
import { launchSchema, operationSchema } from "@/maintenance/maintenance-schema"
import type { LaunchConfiguration, MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { withFileLock } from "@/fs/with-file-lock"
export class NodeMaintenanceStore extends MaintenanceStore {
  constructor(private readonly home: string) {
    super()
    Object.freeze(this)
  }
  readLaunch(): LaunchConfiguration | null {
    const path = join(this.home, "launch.json")
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined
      ? launchSchema.parse(readRegularJson(path))
      : null
  }
  writeLaunch(launch: LaunchConfiguration): void {
    atomicWriteJson({
      path: join(this.home, "launch.json"),
      data: launchSchema.parse(launch),
      mode: 0o600,
    })
  }
  readOperation(): MaintenanceOperation | null {
    const path = join(this.home, "maintenance.json")
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined
      ? operationSchema.parse(readRegularJson(path))
      : null
  }
  writeOperation(operation: MaintenanceOperation): void {
    withFileLock({ lockPath: join(this.home, "maintenance.lock") }, () =>
      atomicWriteJson({
        path: join(this.home, "maintenance.json"),
        data: operationSchema.parse(operation),
        mode: 0o600,
      }),
    )
  }
  updateOperation(
    id: string,
    transform: (current: MaintenanceOperation) => MaintenanceOperation,
  ): MaintenanceOperation | null {
    return withFileLock({ lockPath: join(this.home, "maintenance.lock") }, () => {
      const current = this.readOperation()
      if (current?.id !== id) return null
      const next = operationSchema.parse(transform(current))
      if (next.id !== id) throw new Error("Maintenance update cannot change operation identity")
      atomicWriteJson({ path: join(this.home, "maintenance.json"), data: next, mode: 0o600 })
      return next
    })
  }
}
