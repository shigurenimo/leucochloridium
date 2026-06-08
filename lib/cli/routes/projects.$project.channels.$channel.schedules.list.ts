import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { help } from "@/cli/routes/projects.$project.channels.$channel.schedules.help"
import { findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"
import { LeucoProjectStore } from "@/projects/project-store"

export const schedulesListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const channelName = c.req.param("channel")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  const channel = findChannel(project, channelName)

  if (channel.type !== "schedule") {
    throw new HTTPException(400, { message: `channel "${channelName}" is not a schedule channel` })
  }

  return c.text(
    renderYaml({
      entries: channel.entries.map((e) => ({
        id: e.id,
        name: e.name,
        runAt: e.runAt,
        enabled: e.enabled,
      })),
    }),
  )
})
