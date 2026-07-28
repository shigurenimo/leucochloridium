import { factory } from "@/cli/cli-factory"
import { findConnector, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> connectors <c> stop / disable a connector

usage / leuco projects <p> connectors <c> stop

Sets enabled=false and reloads the daemon. Tokens and config are preserved.`

export const connectorsStopHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const connectorName = c.req.param("connector")!

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)

  const connector = findConnector(project, connectorName)

  if (!connector.enabled) {
    return c.text(`connector "${connectorName}" is already disabled`)
  }

  store.updateProject(project.id, (fresh) => ({
    ...fresh,
    connectors: fresh.connectors.map((ch) =>
      ch.name === connectorName ? { ...ch, enabled: false } : ch,
    ),
  }))

  const reload = c.var.daemon.reload()
  const reloadMsg = reload.signalled ? `(daemon reloaded)` : "(daemon not running)"

  return c.text(`disabled connector "${connectorName}" ${reloadMsg}`)
})
