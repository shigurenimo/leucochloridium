import { CliError } from "@/cli/cli-error"
import type { LeucoSettings } from "@/config/config-schema"

export function removeScheduleFromSettings(settings: LeucoSettings, target: string): LeucoSettings {
  const matching = settings.schedules.filter(
    (entry) => entry.id === target || entry.name === target,
  )
  if (matching.length !== 1)
    throw new CliError("USAGE", "Schedule not found or ambiguous; inspect schedules list")
  return { ...settings, schedules: settings.schedules.filter((entry) => entry !== matching[0]) }
}
