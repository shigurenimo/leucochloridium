import { getBoundedValidationIssues } from "@/get-bounded-validation-issues"
import { settingsSchema } from "@/config/config-schema"
import type { LeucoSettings } from "@/config/config-schema"
import { parseScheduleTime } from "@/cli/parse-schedule-time"
import { CHAT_PROVIDERS } from "@/cli/chat-providers"
import type { ChatProvider } from "@/cli/chat-providers"
import { CliError } from "@/cli/cli-error"

const CREDENTIAL_SETTINGS: ChatProvider[] = ["slack", "discord"]

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
  for (const provider of CREDENTIAL_SETTINGS) {
    const current = settings[provider]?.credential ?? null
    const requested = parsed.data[provider]?.credential ?? null
    if (current === requested) continue
    const definition = CHAT_PROVIDERS[provider]
    const logins = definition.tokens.map((token) => token.login).join(" / ")
    const keep =
      current === null
        ? `${provider} stays null until login`
        : `keep credential ${current} from leuco config show when changing other ${provider} fields`
    throw new CliError(
      "USAGE",
      `${definition.name} credential reference cannot be changed by config set; use ${logins} or leuco ${provider} logout, and ${keep}.`,
      {
        phase: "credential-reference",
        setting: provider,
        currentCredential: current,
        requestedCredential: requested,
      },
    )
  }
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
