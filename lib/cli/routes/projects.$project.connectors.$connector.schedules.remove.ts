import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { help } from "@/cli/routes/projects.$project.connectors.$connector.schedules.help"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

export const schedulesRemoveHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const connectorName = c.req.param("connector")!
  const target = body.args[0]

  if (!target) {
    throw new HTTPException(400, {
      message: "usage: leuco projects <p> connectors <c> schedules remove <id-or-name>",
    })
  }

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)

  store.removeScheduleEntry({
    projectId: project.id,
    connectorName,
    entryIdOrName: target,
  })

  return c.text(`removed schedule entry "${target}"`)
})
