import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { daemonSupervisionWarning, restartDaemon } from "@/daemon/daemon-control"
import { cliEnvSchema } from "@/env/cli-env-schema"

const help = `leuco restart / stop then start

usage / leuco restart`

export const restartHandler = factory.createHandlers(async (c) => {
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

  const result = await restartDaemon({
    daemon: c.var.daemon,
    binPath: c.var.binPath,
    env: process.env,
  })
  if (result instanceof Error) {
    throw new HTTPException(500, { message: result.message })
  }

  const restarted =
    result.mode === "launchd"
      ? `leuco: restarted via launchd (${result.label})`
      : `leuco: restarted (pid ${result.pid})`
  const lines = [restarted, `log: ${result.logPath}`]
  const warning = daemonSupervisionWarning(result)
  if (warning !== null) lines.push(warning)
  return c.text(lines.join("\n"))
})
