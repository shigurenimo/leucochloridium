import { getBoundedValidationIssues } from "@/get-bounded-validation-issues"
import { settingsSchema } from "@/config/config-schema"
import type { LeucoSettings } from "@/config/config-schema"
import { parseScheduleTime } from "@/cli/parse-schedule-time"
import { CliError } from "@/cli/cli-error"

export function parseSettingUpdate(
  settings: LeucoSettings,
  key: string,
  value: unknown,
): LeucoSettings {
  const parsed = settingsSchema.safeParse({ ...settings, [key]: value })
  if (!parsed.success)
    throw new CliError(
      "USAGE",
      "Invalid setting value. Inspect leuco config set --help --json and inputSchemas.settings.",
      getBoundedValidationIssues(parsed.error),
    )
  if (key === "schedules") {
    const previousTimes = new Map<string, string>()
    for (const entry of settings.schedules) previousTimes.set(entry.id, entry.runAt)
    for (const index of parsed.data.schedules.keys()) {
      const entry = parsed.data.schedules[index]!
      if (previousTimes.get(entry.id) !== entry.runAt)
        parseScheduleTime(entry.runAt, `schedules[${index}].runAt`)
    }
  }
  return parsed.data
}
