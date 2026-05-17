import { factory } from "@/cli/cli-factory"
import { findAgent, findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { validateLeucoName } from "@/cli/utils/validate-name"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> channels <c> rename — change a channel's identifier

usage: leuco projects <p> agents <a> channels <c> rename <new-name>

  <new-name>   new identifier; must match ^[a-z][a-z0-9_-]*$

Updates settings.json's channels[i].name. The channel's UUID and tokens stay
untouched, so reactions / posts in flight do not change Slack workspace.`

export const channelsRenameHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const oldName = c.req.param("channel")!
  const newName = body.args[0]
  if (!newName) {
    return c.text(
      `usage: leuco projects ${projectName} agents ${agentName} channels ${oldName} rename <new-name>`,
      400,
    )
  }
  if (newName === oldName) {
    return c.text(`leuco: new name is identical to current name (${oldName})`, 400)
  }

  const validated = validateLeucoName(newName, "channel name")
  if (validated instanceof Error) return c.text(`leuco: ${validated.message}`, 400)

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  const channel = findChannel(agent, projectName, oldName)
  if (channel instanceof Error) return c.text(`leuco: ${channel.message}`, 404)

  if (agent.channels.some((ch) => ch.name === newName)) {
    return c.text(`leuco: channel already exists in ${projectName}/${agentName}: ${newName}`, 400)
  }

  const saved = store.save({
    ...project,
    agents: project.agents.map((a) =>
      a.name === agentName
        ? {
            ...a,
            channels: a.channels.map((ch) => (ch.name === oldName ? { ...ch, name: newName } : ch)),
          }
        : a,
    ),
  })
  if (saved instanceof Error) return c.text(`leuco: ${saved.message}`, 500)

  return c.text(`renamed channel ${projectName}/${agentName}/${oldName} → ${newName}`)
})
