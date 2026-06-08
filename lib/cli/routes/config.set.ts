import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoGlobalSettingsStore } from "@/global-settings/global-settings-store"

const help = `leuco config set — write one key to ~/.leuco/settings.json

usage: leuco config set <key> <value>

Values are coerced to the schema's type:
  - "true" / "false"    → boolean
  - numeric strings     → number
  - everything else     → string

Examples:
  leuco config set keepAwake true
  leuco config set keepAwake false

Restart the daemon (\`leuco restart\`) for changes that affect the spawn (e.g. keepAwake).`

export const configSetHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const key = body.args[0]
  const value = body.args[1]
  if (!key || value === undefined) {
    throw new HTTPException(400, { message: "usage: leuco config set <key> <value>" })
  }

  const store = new LeucoGlobalSettingsStore()
  const updated = store.set(key, value)
  if (updated instanceof Error) {
    // Without this guard the iteration below sees an Error object (entries
    // empty) and the user gets a 200 reply saying `set <key>=undefined` while
    // settings.json was actually never written.
    throw new HTTPException(400, { message: updated.message })
  }

  const found = Object.entries(updated).find((entry) => entry[0] === key)
  return c.text(`set ${key}=${JSON.stringify(found?.[1])}`)
})
