import { requiredCliFlag } from "@/cli/required-cli-flag"
import { scheduleEntrySchema } from "@/config/config-schema"
import { getBoundedValidationIssues } from "@/get-bounded-validation-issues"
import { CliError } from "@/cli/cli-error"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { CliArguments } from "@/cli/parse-arguments"
import { parseSettingUpdate } from "@/cli/parse-setting-update"
import { parseScheduleTime } from "@/cli/parse-schedule-time"
import { removeScheduleFromSettings } from "@/cli/remove-schedule-from-settings"
import type { LeucoStore } from "@/storage/leuco-store"

export async function manageSettings(parsed: CliArguments, store: LeucoStore): Promise<unknown> {
  const command = parsed.words[0]
  const action = parsed.words[1]
  if (command === "config" && action === "show") {
    const settings = store.loadSettings()
    return settings
  }
  if (command === "config" && action === "set") {
    const key = parsed.words[2]
    const raw = parsed.words[3]
    if (!key || raw === undefined) throw new Error("Usage: leuco config set <key> <json>")
    if (raw === "-")
      throw new CliError(
        "USAGE",
        "stdin input is disabled; pass the JSON setting value as an argument",
      )
    const value: unknown = parseJson(raw)
    const normalized =
      (key === "cwd" || key === "soul") && typeof value === "string" ? resolve(value) : value
    parseSettingUpdate(store.loadSettings(), key, normalized)
    store.updateSettings((settings) => parseSettingUpdate(settings, key, normalized))
    return { saved: key, restartRequired: key !== "schedules" }
  }
  if (command === "schedules" && action === "list") return store.loadSettings().schedules
  if (command === "schedules" && action === "add") {
    const name = requiredCliFlag(parsed, "name")
    const runAt = parseScheduleTime(requiredCliFlag(parsed, "run-at"))
    const prompt = requiredCliFlag(parsed, "prompt")
    const entry = scheduleEntrySchema.safeParse({
      id: randomUUID(),
      name,
      runAt,
      prompt,
      enabled: true,
    })
    if (!entry.success)
      throw new CliError("USAGE", "Invalid schedule input", getBoundedValidationIssues(entry.error))
    store.updateSettings((settings) => {
      if (settings.schedules.some((entry) => entry.name === name))
        throw new CliError(
          "USAGE",
          `Schedule '${name}' already exists; inspect schedules list and choose a unique name`,
        )
      return {
        ...settings,
        schedules: [...settings.schedules, entry.data],
      }
    })
    return { added: name }
  }
  if (command === "schedules" && action === "remove") {
    const name = parsed.words[2]
    if (!name) throw new CliError("USAGE", "Schedule name or ID is required")
    removeScheduleFromSettings(store.loadSettings(), name)
    store.updateSettings((settings) => removeScheduleFromSettings(settings, name))
    return { removed: name }
  }
  throw new Error(`Unknown ${command} command: ${action}`)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new CliError("USAGE", "Invalid JSON setting value; read leuco config set --help --json")
  }
}
