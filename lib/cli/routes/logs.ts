import { HTTPException } from "hono/http-exception"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"

const help = `leuco logs / print the daemon diagnostic log

usage / leuco logs [-f|--follow]

options:
  -f, --follow / tail -F the log (streams until Ctrl-C)

This is the daemon's plain-text diagnostic stream (startup, shutdown, errors).
It does NOT contain structured events. For structured events, use:
  leuco events                     last 20 events
  leuco events --preset errors     turn errors + reconcile failures

examples:
  leuco logs
  leuco logs -f
  leuco logs -f | grep -i error

see also: leuco events, leuco status`

export const logsHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const logPath = c.var.daemon.getLogPath()

  if (!existsSync(logPath)) {
    throw new HTTPException(404, { message: `no log file yet: ${logPath}` })
  }

  const follow = flagBool(body.flags.follow)
  const tailArgs = follow ? ["-F", logPath] : [logPath]
  const child = spawn("tail", tailArgs, { stdio: "inherit" })

  child.on("exit", (code) => {
    process.exit(code ?? 0)
  })

  child.on("error", (err) => {
    process.stderr.write(`tail failed: ${err.message}\n`)
    process.exit(1)
  })

  // tail keeps the process alive; never resolve so index.ts doesn't write a body.
  return new Promise<Response>(() => {})
})
