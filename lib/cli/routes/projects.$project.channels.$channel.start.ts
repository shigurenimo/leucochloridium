import { factory } from "@/cli/cli-factory"
import { findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> channels <c> start / enable a channel

usage / leuco projects <p> channels <c> start

Sets enabled=true and reloads the daemon so the listener connects.`

export const channelsStartHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const channelName = c.req.param("channel")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  const channel = findChannel(project, channelName)

  if (channel.enabled) {
    return c.text(`channel "${channelName}" is already enabled`)
  }

  store.save({
    ...project,
    channels: project.channels.map((ch) =>
      ch.name === channelName ? { ...ch, enabled: true } : ch,
    ),
  })

  const reload = c.var.daemon.reload()
  const reloadMsg = reload.signalled ? `(daemon reloaded)` : "(daemon not running)"

  return c.text(`enabled channel "${channelName}" ${reloadMsg}`)
})
