import { HTTPException } from "hono/http-exception"
import { LeucoLaunchAgent } from "@/boot/leuco-launch-agent"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"

const help = `leuco boot — auto-start the daemon at login (macOS only)

usage:
  leuco boot                          print LaunchAgent install + load state
  leuco boot install                  install the LaunchAgent and load it
  leuco boot uninstall                unload and delete the LaunchAgent plist

The LaunchAgent runs \`bun <leuco-bin> run\` in the foreground; launchd
supervises it and restarts on crash. The current PATH and any LEUCO_*
env vars from the invoking shell are captured into the plist so codex
and friends resolve at boot.

Re-running \`install\` is safe: the existing agent is booted out, the
plist is rewritten with the latest paths / env, and bootstrapped again.

Bare \`leuco boot\` prints whether the plist exists on disk and whether
launchctl currently has it loaded. Read-only.

Run \`leuco boot <subcommand> -h\` for details on a specific subcommand.`

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
    [
      `label:     ${status.label}`,
      `plist:     ${status.plistPath}`,
      `installed: ${status.isInstalled ? "yes" : "no"}`,
      `loaded:    ${status.isLoaded ? "yes" : "no"}`,
    ].join("\n"),
  )
})
