import { HTTPException } from "hono/http-exception"
import { LeucoLaunchAgent } from "@/boot/leuco-launch-agent"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoPaths } from "@/paths/leuco-paths"

const help = `leuco boot install / install the macOS LaunchAgent

usage / leuco boot install

Writes ~/Library/LaunchAgents/io.leuco.daemon.plist and loads it via
\`launchctl bootstrap\`. Re-running is idempotent. The plist captures PATH
and LEUCO_* env vars from the current shell.`

export const bootInstallHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  if (process.platform !== "darwin") {
    throw new HTTPException(400, { message: "leuco boot is only supported on macOS" })
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
    throw new HTTPException(500, { message: result.message })
  }

  return c.text(`leuco boot: installed "${result.label}"\nplist: ${result.plistPath}`)
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
