import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { help } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.schedules.help"
import { findAgent, findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

export const schedulesListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const channelName = c.req.param("channel")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  const agent = findAgent(project, agentName)

  const channel = findChannel(agent, projectName, channelName)

  if (channel.type !== "schedule") {
    throw new HTTPException(400, { message: `channel ${channelName} is not a schedule channel` })
  }

  if (channel.entries.length === 0) return c.text("(no schedule entries)")

  const lines = channel.entries.map((e) => {
    const state = e.enabled ? "enabled" : "disabled"
    return `${e.name}\t${e.runAt}\t${state}\t${e.id}`
  })
  return c.text(lines.join("\n"))
})
