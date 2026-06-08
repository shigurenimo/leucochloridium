import { factory } from "@/cli/cli-factory"
import { formatStatus } from "@/cli/utils/format-status"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"

const help = `leuco status / show daemon and project state

usage / leuco status

output / valid YAML with: running (bool), pid, log path, projects array

exit codes:
  0 / running
  1 / not running (or stale pid file cleared)

examples:
  leuco status
  leuco status | yq '.projects'

see also: leuco events, leuco logs -f`

export const statusHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const { text, isRunning } = formatStatus(c.var.daemon)
  return c.text(text, isRunning ? 200 : 503)
})
