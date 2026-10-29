import { CliError } from "@/cli/cli-error"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { CliArguments } from "@/cli/parse-arguments"
import { settingsSchema } from "@/config/config-schema"
import { validateRunAt } from "@/connectors/schedule/validate-run-at"
import type { LeucoStore } from "@/storage/leuco-store"

export async function manageSettings(parsed: CliArguments, store: LeucoStore): Promise<unknown> {
  const command = parsed.words[0]
  const action = parsed.words[1] ?? (command === "config" ? "show" : "list")
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
    if (!settingsSchema.safeParse({ ...store.loadSettings(), [key]: normalized }).success)
      throw new CliError(
        "USAGE",
        "Invalid setting value. Inspect leuco config set --help --json and inputSchemas.settings.",
      )
    store.updateSettings((settings) => {
      const parsed = settingsSchema.safeParse({ ...settings, [key]: normalized })
      if (!parsed.success)
        throw new CliError(
          "USAGE",
          "Invalid setting value. Inspect leuco config set --help --json and inputSchemas.settings.",
        )
      return parsed.data
    })
    return { saved: key, restartRequired: key !== "schedules" }
  }
  if (command === "schedules" && action === "list") return store.loadSettings().schedules
  if (command === "schedules" && action === "add") {
    const name = required(parsed, "name")
    const runAt = validateRunAt(required(parsed, "run-at"))
    const prompt = required(parsed, "prompt")
    store.updateSettings((settings) => ({
      ...settings,
      schedules: [...settings.schedules, { id: randomUUID(), name, runAt, prompt, enabled: true }],
    }))
    return { added: name }
  }
  if (command === "schedules" && action === "remove") {
    const name = parsed.words[2]
    if (!name) throw new CliError("USAGE", "Schedule name or ID is required")
    store.updateSettings((settings) => {
      const matching = settings.schedules.filter(
        (entry) => entry.id === name || entry.name === name,
      )
      if (matching.length !== 1)
        throw new CliError("USAGE", "Schedule not found or ambiguous; inspect schedules list")
      return { ...settings, schedules: settings.schedules.filter((entry) => entry !== matching[0]) }
    })
    return { removed: name }
  }
  throw new Error(`Unknown ${command} command: ${action}`)
}

export function required(parsed: CliArguments, name: string): string {
  const value = parsed.flags[name]
  if (typeof value !== "string") throw new Error(`--${name} is required`)
  return value
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new CliError("USAGE", "Invalid JSON setting value; read leuco config set --help --json")
  }
}
