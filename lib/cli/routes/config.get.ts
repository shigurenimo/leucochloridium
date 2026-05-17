import { HTTPException } from "hono/http-exception"
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

  const found = Object.entries(settings).find((entry) => entry[0] === key)
  if (!found) throw new HTTPException(404, { message: `unknown config key: ${key}` })

  return c.text(JSON.stringify(found[1]))
})
