import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { help } from "@/cli/routes/projects.$project.connectors.$connector.schedules.help"
import { findConnector, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"
import { LeucoProjectStore } from "@/projects/project-store"

export const schedulesListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const connectorName = c.req.param("connector")!

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)

  const connector = findConnector(project, connectorName)

  if (connector.type !== "schedule") {
    throw new HTTPException(400, {
      message: `connector "${connectorName}" is not a schedule connector`,
    })
  }

  return c.text(
    renderYaml({
      entries: connector.entries.map((e) => ({
        id: e.id,
        name: e.name,
        runAt: e.runAt,
        enabled: e.enabled,
      })),
    }),
  )
})
