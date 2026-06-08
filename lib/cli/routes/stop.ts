import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"

const help = `leuco stop / stop the running daemon

usage / leuco stop

Sends SIGTERM to the daemon (if alive) and clears the pid file.`

export const stopHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const result = c.var.daemon.stop()

  if (result.stopped) {
    return c.text(`leuco: stopped (pid ${result.pid})`)
  }

  if (result.pid !== null) {
    return c.text(`leuco: pid ${result.pid} was not alive; cleared pid file`)
  }

  return c.text("leuco: not running")
})
