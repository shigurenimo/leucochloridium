import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"
import { LeucoGlobalSettingsStore } from "@/global-settings/global-settings-store"

const help = `leuco config / read and write machine-wide settings

usage / leuco config [subcommand]

subcommands:
  (none) / print every key in ~/.leuco/settings.json
  get <key> / print one key
  set <key> <value> / write one key (validated against the schema)

output / valid YAML`

export const configListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const store = new LeucoGlobalSettingsStore()
  const settings = store.load()
  if (settings instanceof Error) {
    throw new HTTPException(500, { message: `failed to load settings: ${settings.message}` })
  }

  return c.text(renderYaml(settings))
})
