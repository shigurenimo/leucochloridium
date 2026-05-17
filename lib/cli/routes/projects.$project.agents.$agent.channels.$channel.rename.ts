import { HTTPException } from "hono/http-exception"
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
    throw new HTTPException(400, { message: `new name is identical to current name (${oldName})` })
  }

  validateLeucoName(newName, "channel name")

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  const agent = findAgent(project, agentName)

  findChannel(agent, projectName, oldName)

  if (agent.channels.some((ch) => ch.name === newName)) {
    throw new HTTPException(400, {
      message: `channel already exists in ${projectName}/${agentName}: ${newName}`,
    })
  }

  store.save({
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

  return c.text(`renamed channel ${projectName}/${agentName}/${oldName} → ${newName}`)
})
