import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
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

  const daemon = c.var.daemon
  const lines: string[] = []

  const stopped = daemon.stop()
  if (stopped.stopped) {
    lines.push(`stopped (pid ${stopped.pid})`)
  }

  const result = daemon.start({ binPath: c.var.binPath, env: process.env })

  lines.push(`leuco: started (pid ${result.pid})`)
  lines.push(`log: ${result.logPath}`)
  return c.text(lines.join("\n"))
})
