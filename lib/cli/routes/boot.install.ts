import { LeucoLaunchAgent } from "@/boot/leuco-launch-agent"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoPaths } from "@/paths/leuco-paths"

const help = `leuco boot install — install the macOS LaunchAgent

usage: leuco boot install

Writes ~/Library/LaunchAgents/io.leuco.daemon.plist and loads it via
\`launchctl bootstrap\`. Re-running is idempotent; the existing agent is
booted out and replaced with the latest paths / env.

The plist captures PATH and any LEUCO_* env vars from the current shell
so the daemon resolves codex and other binaries at boot.`

export const bootInstallHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  if (process.platform !== "darwin") {
    return c.text("leuco boot is only supported on macOS", 400)
  }

  const paths = new LeucoPaths()
  const agent = new LeucoLaunchAgent({ paths })

  const envVars = pickEnvVars(process.env)

  const result = await agent.install({
    bunPath: process.execPath,
    binPath: c.var.binPath,
    workingDirectory: paths.getHome(),
    envVars,
  })

  if (result instanceof Error) {
    return c.text(`leuco: ${result.message}`, 500)
  }

  return c.text(
    [
      `[leuco] installed ${result.label}`,
      `        plist: ${result.plistPath}`,
      "",
      "the daemon will start at the next login.",
      "run `leuco status` to confirm it's running, or log out and back in.",
    ].join("\n"),
  )
})

const pickEnvVars = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {}

  if (typeof env.PATH === "string") out.PATH = env.PATH

  for (const key of Object.keys(env)) {
    if (!key.startsWith("LEUCO_")) continue
    const value = env[key]
    if (typeof value === "string") out[key] = value
  }

  return out
}
