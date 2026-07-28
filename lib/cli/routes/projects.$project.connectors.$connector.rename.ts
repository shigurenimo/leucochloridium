import { HTTPException } from "hono/http-exception"
import { assertRoutableName } from "@/cli/utils/assert-routable-name"
import { factory } from "@/cli/cli-factory"
import { findConnector, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> connectors <c> rename / change a connector's identifier

usage / leuco projects <p> connectors <c> rename <new-name>

The connector's UUID and tokens stay untouched.`

export const connectorsRenameHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const oldName = c.req.param("connector")!
  const newName = body.args[0]
  if (!newName) {
    throw new HTTPException(400, {
      message: `usage: leuco projects ${projectName} connectors ${oldName} rename <new-name>`,
    })
  }
  if (newName === oldName) {
    throw new HTTPException(400, { message: `new name is identical to current name (${oldName})` })
  }

  assertRoutableName(newName, "connector name")

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)

  findConnector(project, oldName)

  if (project.connectors.some((ch) => ch.name === newName)) {
    throw new HTTPException(400, {
      message: `connector already exists in ${projectName}: ${newName}`,
    })
  }

  store.updateProject(project.id, (fresh) => ({
    ...fresh,
    connectors: fresh.connectors.map((ch) => (ch.name === oldName ? { ...ch, name: newName } : ch)),
  }))

  const lines = [`renamed connector "${oldName}" to "${newName}"`]
  const reloaded = c.var.daemon.reload()
  if (reloaded.signalled) lines.push(`daemon reloaded (pid ${reloaded.pid})`)

  return c.text(lines.join("\n"))
})
