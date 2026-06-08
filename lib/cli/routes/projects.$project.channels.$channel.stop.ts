import { factory } from "@/cli/cli-factory"
import { findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> channels <c> stop / disable a channel

usage / leuco projects <p> channels <c> stop

Sets enabled=false and reloads the daemon. Tokens and config are preserved.`

export const channelsStopHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const channelName = c.req.param("channel")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  const channel = findChannel(project, channelName)

  if (!channel.enabled) {
    return c.text(`channel "${channelName}" is already disabled`)
  }

  store.save({
    ...project,
    channels: project.channels.map((ch) =>
      ch.name === channelName ? { ...ch, enabled: false } : ch,
    ),
  })

  const reload = c.var.daemon.reload()
  const reloadMsg = reload.signalled ? `(daemon reloaded)` : "(daemon not running)"

  return c.text(`disabled channel "${channelName}" ${reloadMsg}`)
})
