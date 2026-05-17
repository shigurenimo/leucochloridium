import { factory } from "@/cli/cli-factory"
import { help } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.schedules.help"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

export const schedulesRemoveHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const channelName = c.req.param("channel")!
  const target = body.args[0]

  if (!target) {
    return c.text(
      "usage: leuco projects <p> agents <a> channels <c> schedules remove <id-or-name>",
      400,
    )
  }

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  store.removeScheduleEntry({
    projectId: project.id,
    agentName,
    channelName,
    entryIdOrName: target,
  })

  return c.text(`removed schedule entry ${projectName}/${agentName}/${channelName}/${target}`)
})
