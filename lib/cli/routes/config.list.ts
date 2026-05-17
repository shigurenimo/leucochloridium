import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoGlobalSettingsStore } from "@/global-settings/global-settings-store"

const help = `leuco config list — print every key in ~/.leuco/settings.json

usage: leuco config list

Output is JSON. Missing file prints the schema defaults.`

export const configListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const store = new LeucoGlobalSettingsStore()
  const settings = store.load()

  return c.text(JSON.stringify(settings, null, 2))
})
