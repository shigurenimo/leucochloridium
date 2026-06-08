import { factory } from "@/cli/cli-factory"
import { formatStatus } from "@/cli/utils/format-status"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"

const help = `leuco status — show daemon status

usage: leuco status

Prints whether the per-cwd daemon is running, plus the pid and log path.

exit codes:
  0  running
  1  not running (or stale pid file cleared)`

export const statusHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const { lines, isRunning } = formatStatus(c.var.daemon)
  return c.text(lines.join("\n"), isRunning ? 200 : 503)
})
