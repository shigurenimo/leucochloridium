import { HTTPException } from "hono/http-exception"
import { LeucoLaunchAgent } from "@/boot/leuco-launch-agent"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"

const help = `leuco boot / auto-start the daemon at login (macOS only)

usage / leuco boot [subcommand]

subcommands:
  (none) / print LaunchAgent install + load state
  install / install the LaunchAgent and load it
  uninstall / unload and delete the LaunchAgent plist

Re-running \`install\` is safe: the existing agent is replaced with the latest
paths / env. The LaunchAgent runs \`bun <leuco-bin> run\` in foreground; launchd
supervises it and restarts on crash.

output / valid YAML`

export const bootStatusHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  if (process.platform !== "darwin") {
    throw new HTTPException(400, { message: "leuco boot is only supported on macOS" })
  }

  const agent = new LeucoLaunchAgent()
  const status = await agent.status()

  if (status instanceof Error) {
    throw new HTTPException(500, { message: status.message })
  }

  return c.text(
    renderYaml({
      label: status.label,
      plist: status.plistPath,
      installed: status.isInstalled,
      loaded: status.isLoaded,
    }),
  )
})
