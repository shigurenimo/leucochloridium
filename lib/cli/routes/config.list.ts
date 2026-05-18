import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoGlobalSettingsStore } from "@/global-settings/global-settings-store"

const help = `leuco config — read and write machine-wide settings

usage:
  leuco config                          print every key in ~/.leuco/settings.json
  leuco config get <key>                print one key
  leuco config set <key> <value>        write one key (validated against the schema)

Recognised keys:
  keepAwake (boolean)    macOS: keep the system awake while leuco runs
                         (wraps the daemon launch with \`caffeinate -is\`,
                         blocking idle sleep + system/clamshell sleep on AC).
                         Defaults to true. Restart the daemon to pick up
                         changes (\`leuco restart\`); for the LaunchAgent
                         path, re-run \`leuco boot install\`.

Output of bare \`leuco config\` is JSON. Missing file prints the schema defaults.`

export const configListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const store = new LeucoGlobalSettingsStore()
  const settings = store.load()

  return c.text(JSON.stringify(settings, null, 2))
})
