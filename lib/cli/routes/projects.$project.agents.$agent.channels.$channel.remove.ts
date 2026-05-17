import { factory } from "@/cli/cli-factory"
import { findAgent, findChannel, resolveProject } from "@/cli/utils/lookup-config"
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
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  const agent = findAgent(project, agentName)

  findChannel(agent, projectName, channelName)

  store.save({
    ...project,
    agents: project.agents.map((a) =>
      a.name === agentName
        ? { ...a, channels: a.channels.filter((ch) => ch.name !== channelName) }
        : a,
    ),
  })

  return c.text(`removed channel ${projectName}/${agentName}/${channelName}`)
})
