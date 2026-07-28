import { factory } from "@/cli/cli-factory"
import { findConnector, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> connectors <c> start / enable a connector

usage / leuco projects <p> connectors <c> start

Sets enabled=true and reloads the daemon so the listener connects.`

export const connectorsStartHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const connectorName = c.req.param("connector")!

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)

  const connector = findConnector(project, connectorName)

  if (connector.enabled) {
    return c.text(`connector "${connectorName}" is already enabled`)
  }

  store.updateProject(project.id, (fresh) => ({
    ...fresh,
    connectors: fresh.connectors.map((ch) =>
      ch.name === connectorName ? { ...ch, enabled: true } : ch,
    ),
  }))

  const reload = c.var.daemon.reload()
  const reloadMsg = reload.signalled ? `(daemon reloaded)` : "(daemon not running)"

  return c.text(`enabled connector "${connectorName}" ${reloadMsg}`)
})
