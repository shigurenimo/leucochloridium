import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { cliEnvSchema } from "@/env/cli-env-schema"

const help = `leuco restart — stop then start

usage: leuco restart

Equivalent to \`leuco stop && leuco start\`.`

export const restartHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const env = cliEnvSchema.safeParse(process.env)
  if (!env.success) {
    const lines = env.error.issues.map((issue) => {
      const key = issue.path.join(".")
      return `leuco: ${key}: ${issue.message}`
    })
    lines.push("run `leuco --help` for usage.")
    return c.text(lines.join("\n"), 400)
  }

  const daemon = c.var.daemon
  const lines: string[] = []

  const stopped = daemon.stop()
  if (stopped.stopped) {
    lines.push(`stopped (pid ${stopped.pid})`)
  }

  const result = daemon.start({ binPath: c.var.binPath, env: process.env })
  if (result instanceof Error) {
    lines.push(`leuco: ${result.message}`)
    return c.text(lines.join("\n"), 500)
  }

  lines.push(
    `[leuco] started in background (pid ${result.pid})`,
    `        log: ${result.logPath}`,
    "",
    "run `leuco logs -f` to tail logs, `leuco stop` to stop.",
  )
  return c.text(lines.join("\n"))
})
