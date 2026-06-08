import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
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

  const result = c.var.daemon.start({ binPath: c.var.binPath, env: process.env })

  return c.text(`leuco: started (pid ${result.pid})\nlog: ${result.logPath}`)
})
