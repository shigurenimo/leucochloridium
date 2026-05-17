import { factory } from "@/cli/cli-factory"
import { findAgent, findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> channels <c> start — enable a channel

usage: leuco projects <p> agents <a> channels <c> start

Sets the channel's \`enabled\` flag to true in settings.json and reloads the
daemon (if running) so the Slack listener for this channel is connected.`

export const channelsStartHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const channelName = c.req.param("channel")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  const agent = findAgent(project, agentName)

  const channel = findChannel(agent, projectName, channelName)

  if (channel.enabled) {
    return c.text(`channel ${projectName}/${agentName}/${channelName} is already enabled`)
  }

  store.save({
    ...project,
    agents: project.agents.map((a) =>
      a.name === agentName
        ? {
            ...a,
            channels: a.channels.map((ch) =>
              ch.name === channelName ? { ...ch, enabled: true } : ch,
            ),
          }
        : a,
    ),
  })

  const reload = c.var.daemon.reload()
  const reloadMsg = reload.signalled ? `(daemon reloaded)` : "(daemon not running)"

  return c.text(`enabled channel ${projectName}/${agentName}/${channelName} ${reloadMsg}`)
})
