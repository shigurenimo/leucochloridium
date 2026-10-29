import { operationSchema } from "@/maintenance/maintenance-schema"
import { MaintenanceStore } from "@/maintenance/maintenance-store"
import type { LaunchConfiguration, MaintenanceOperation } from "@/maintenance/maintenance-schema"
export class MemoryMaintenanceStore extends MaintenanceStore {
  private launch: LaunchConfiguration | null = null
  private operation: MaintenanceOperation | null = null
  readLaunch(): LaunchConfiguration | null {
    return structuredClone(this.launch)
  }
  writeLaunch(launch: LaunchConfiguration): void {
    this.launch = structuredClone(launch)
  }
  readOperation(): MaintenanceOperation | null {
    return structuredClone(this.operation)
  }
  writeOperation(operation: MaintenanceOperation): void {
    this.operation = operationSchema.parse(structuredClone(operation))
  }
  updateOperation(
    id: string,
    transform: (current: MaintenanceOperation) => MaintenanceOperation,
  ): MaintenanceOperation | null {
    const current = this.readOperation()
    if (current?.id !== id) return null
    const next = operationSchema.parse(transform(current))
    if (next.id !== id) throw new Error("Maintenance update cannot change operation identity")
    this.operation = structuredClone(next)
    return structuredClone(next)
  }
}
