import { encodeLocalJson } from "@/fs/encode-local-json"
import { launchSchema, operationSchema } from "@/maintenance/maintenance-schema"
import { MaintenanceStore } from "@/maintenance/maintenance-store"
import type { LaunchConfiguration, MaintenanceOperation } from "@/maintenance/maintenance-schema"
export class MemoryMaintenanceStore extends MaintenanceStore {
  private launch: LaunchConfiguration | null = null
  private operation: MaintenanceOperation | null = null
  readLaunch(): LaunchConfiguration | null {
    return structuredClone(this.launch)
  }
  writeLaunch(launch: LaunchConfiguration): void {
    const next = launchSchema.parse(structuredClone(launch))
    encodeLocalJson(next)
    this.launch = next
  }
  readOperation(): MaintenanceOperation | null {
    return structuredClone(this.operation)
  }
  writeOperation(operation: MaintenanceOperation): void {
    const next = operationSchema.parse(structuredClone(operation))
    encodeLocalJson(next)
    this.operation = next
  }
  updateOperation(
    id: string,
    transform: (current: MaintenanceOperation) => MaintenanceOperation,
  ): MaintenanceOperation | null {
    const current = this.readOperation()
    if (current?.id !== id) return null
    const next = operationSchema.parse(transform(current))
    if (next.id !== id) throw new Error("Maintenance update cannot change operation identity")
    encodeLocalJson(next)
    this.operation = structuredClone(next)
    return structuredClone(next)
  }
}
