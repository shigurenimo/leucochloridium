import { factory } from "@/cli/cli-factory"
import { findAgent, findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> channels <c> stop — disable a channel

usage: leuco projects <p> agents <a> channels <c> stop

Sets the channel's \`enabled\` flag to false. Reloads the daemon if running
so the Slack listener disconnects. Tokens and config are preserved.`

export const channelsStopHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const channelName = c.req.param("channel")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  const channel = findChannel(agent, projectName, channelName)
  if (channel instanceof Error) return c.text(`leuco: ${channel.message}`, 404)

  if (!channel.enabled) {
    return c.text(`channel ${projectName}/${agentName}/${channelName} is already disabled`)
  }

  const saved = store.save({
    ...project,
    agents: project.agents.map((a) =>
      a.name === agentName
        ? {
            ...a,
            channels: a.channels.map((ch) =>
              ch.name === channelName ? { ...ch, enabled: false } : ch,
            ),
          }
        : a,
    ),
  })
  if (saved instanceof Error) return c.text(`leuco: ${saved.message}`, 500)

  const reload = c.var.daemon.reload()
  const reloadMsg = reload.signalled ? `(daemon reloaded)` : "(daemon not running)"

  return c.text(`disabled channel ${projectName}/${agentName}/${channelName} ${reloadMsg}`)
})
