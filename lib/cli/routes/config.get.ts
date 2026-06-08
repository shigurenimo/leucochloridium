import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"
import { LeucoGlobalSettingsStore } from "@/global-settings/global-settings-store"

const help = `leuco config get / print one key from ~/.leuco/settings.json

usage / leuco config get <key>

output / valid YAML`

export const configGetHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const key = body.args[0]
  if (!key) throw new HTTPException(400, { message: "usage: leuco config get <key>" })
  if (key === "projects")
    throw new HTTPException(400, { message: "use `leuco projects` to list projects" })

  const store = new LeucoGlobalSettingsStore()
  const settings = store.load()
  if (settings instanceof Error) {
    throw new HTTPException(500, { message: `failed to load settings: ${settings.message}` })
  }

  const found = Object.entries(settings).find((entry) => entry[0] === key)
  if (!found) throw new HTTPException(404, { message: `unknown config key: ${key}` })

  return c.text(renderYaml(found[1]))
})
