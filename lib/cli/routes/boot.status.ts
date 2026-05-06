import { LeucoLaunchAgent } from "@/boot/leuco-launch-agent"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"

const help = `leuco boot status — show LaunchAgent install + load state

usage: leuco boot status

Prints whether the plist exists on disk and whether launchctl currently
has it loaded. Read-only.`

export const bootStatusHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  if (process.platform !== "darwin") {
    return c.text("leuco boot is only supported on macOS", 400)
  }

  const agent = new LeucoLaunchAgent()
  const status = await agent.status()

  if (status instanceof Error) {
    return c.text(`leuco: ${status.message}`, 500)
  }

  return c.text(
    [
      `label:     ${status.label}`,
      `plist:     ${status.plistPath}`,
      `installed: ${status.isInstalled ? "yes" : "no"}`,
      `loaded:    ${status.isLoaded ? "yes" : "no"}`,
    ].join("\n"),
  )
})
