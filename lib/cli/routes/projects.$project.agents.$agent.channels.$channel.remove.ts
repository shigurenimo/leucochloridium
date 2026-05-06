import { factory } from "@/cli/cli-factory"
import { findAgent, findChannel } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> channels <c> remove — drop a channel

usage: leuco projects <p> agents <a> channels <c> remove

Removes the channel entry from ~/.leuco/config.json. Tokens are never written
to config so nothing else needs cleanup.`

export const channelsRemoveHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const channelName = c.req.param("channel")!

  const store = new LeucoProjectStore()
  const project = store.load(projectName)
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  const channel = findChannel(agent, projectName, channelName)
  if (channel instanceof Error) return c.text(`leuco: ${channel.message}`, 404)

  const saved = store.save({
    ...project,
    agents: project.agents.map((a) =>
      a.name === agentName
        ? { ...a, channels: a.channels.filter((ch) => ch.name !== channelName) }
        : a,
    ),
  })
  if (saved instanceof Error) return c.text(`leuco: ${saved.message}`, 500)

  return c.text(`removed channel ${projectName}/${agentName}/${channelName}`)
})
