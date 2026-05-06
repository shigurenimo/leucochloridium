import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoGlobalSettingsStore } from "@/global-settings/global-settings-store"

const help = `leuco config get — print one key from ~/.leuco/settings.json

usage: leuco config get <key>

Returns the value as JSON (so booleans / numbers round-trip cleanly).
Unknown keys produce an error.`

export const configGetHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const key = body.args[0]
  if (!key) return c.text("usage: leuco config get <key>", 400)

  const store = new LeucoGlobalSettingsStore()
  const settings = store.load()
  if (settings instanceof Error) return c.text(`leuco: ${settings.message}`, 500)

  if (!Object.hasOwn(settings, key)) {
    return c.text(`leuco: unknown config key: ${key}`, 404)
  }

  const value = (settings as Record<string, unknown>)[key]
  return c.text(JSON.stringify(value))
})
