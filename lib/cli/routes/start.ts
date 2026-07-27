import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { daemonSupervisionWarning, startDaemon } from "@/daemon/daemon-control"
import { cliEnvSchema } from "@/env/cli-env-schema"

const help = `leuco start / start the daemon in background

usage / leuco start

Spawns \`bun <bin> run\` detached with the caller's env. PID + logs land
in ~/.leuco/daemon/{pid,log}.`

export const startHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const env = cliEnvSchema.safeParse(process.env)
  if (!env.success) {
    const lines = env.error.issues.map((issue) => {
      const key = issue.path.join(".")
      return `${key}: ${issue.message}`
    })
    lines.push("run `leuco --help` for usage.")
    throw new HTTPException(400, { message: lines.join("\n") })
  }

  const result = await startDaemon({
    daemon: c.var.daemon,
    binPath: c.var.binPath,
    env: process.env,
  })
  if (result instanceof Error) {
    throw new HTTPException(500, { message: result.message })
  }

  const started =
    result.mode === "launchd"
      ? `leuco: started via launchd (${result.label})`
      : `leuco: started (pid ${result.pid})`
  const lines = [started, `log: ${result.logPath}`]
  const warning = daemonSupervisionWarning(result)
  if (warning !== null) lines.push(warning)
  return c.text(lines.join("\n"))
})
