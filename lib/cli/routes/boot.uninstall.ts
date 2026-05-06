import { LeucoLaunchAgent } from "@/boot/leuco-launch-agent"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"

const help = `leuco boot uninstall — remove the macOS LaunchAgent

usage: leuco boot uninstall

Calls \`launchctl bootout\` and deletes
~/Library/LaunchAgents/io.leuco.daemon.plist. Idempotent — succeeds
even if the agent was never installed.

The currently running daemon is not stopped; run \`leuco stop\` if you
want to take it down too.`

export const bootUninstallHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  if (process.platform !== "darwin") {
    return c.text("leuco boot is only supported on macOS", 400)
  }

  const agent = new LeucoLaunchAgent()
  const result = await agent.uninstall()

  if (result instanceof Error) {
    return c.text(`leuco: ${result.message}`, 500)
  }

  if (!result.removed) {
    return c.text(`not installed (${result.plistPath} does not exist)`)
  }

  return c.text(
    [`[leuco] uninstalled ${result.label}`, `        removed: ${result.plistPath}`].join("\n"),
  )
})
