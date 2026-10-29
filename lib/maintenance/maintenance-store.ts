import type { LaunchConfiguration, MaintenanceOperation } from "@/maintenance/maintenance-schema"
export abstract class MaintenanceStore {
  abstract readLaunch(): LaunchConfiguration | null
  abstract writeLaunch(launch: LaunchConfiguration): void
  abstract readOperation(): MaintenanceOperation | null
  abstract writeOperation(operation: MaintenanceOperation): void
  abstract updateOperation(
    id: string,
    transform: (current: MaintenanceOperation) => MaintenanceOperation,
  ): MaintenanceOperation | null
}
