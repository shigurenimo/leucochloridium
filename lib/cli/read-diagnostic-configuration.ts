import { errorDetails } from "@/error-details"
import { settingsSchema } from "@/config/config-schema"
import type { LaunchConfiguration } from "@/maintenance/maintenance-schema"
import type { MaintenanceStore } from "@/maintenance/maintenance-store"
import type { LeucoStore } from "@/storage/leuco-store"

export function readDiagnosticConfiguration(store: LeucoStore, maintenance: MaintenanceStore) {
  const errors: string[] = []
  const failures: Array<{ phase: string; causes: ReturnType<typeof errorDetails> }> = []
  const configuration = { settings: settingsSchema.parse({}), valid: true, stateValid: true }
  try {
    configuration.settings = store.loadSettings()
  } catch (error) {
    failures.push({ phase: "settings", causes: errorDetails(error) })
    configuration.valid = false
    errors.push("Settings are invalid/unreadable; contents were not overwritten")
  }
  try {
    store.loadState()
  } catch (error) {
    failures.push({ phase: "state", causes: errorDetails(error) })
    configuration.stateValid = false
    errors.push(
      "Runtime state is invalid; verify the daemon is stopped before repair --reset-state archives it without deleting Codex history",
    )
  }
  const launch: { value: LaunchConfiguration | null } = { value: null }
  try {
    launch.value = maintenance.readLaunch()
  } catch (error) {
    failures.push({ phase: "launch", causes: errorDetails(error) })
    errors.push("Recorded launch options are invalid; preserve launch.json for inspection")
  }
  return { ...configuration, launch: launch.value, errors, failures }
}
