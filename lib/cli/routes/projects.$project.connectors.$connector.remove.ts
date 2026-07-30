import { factory } from "@/cli/cli-factory"
import { findConnector, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { withPausedProject } from "@/cli/utils/with-paused-project"
import { DaemonControlClient } from "@/control/daemon-control-client"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> connectors <c> remove / drop a connector

usage / leuco projects <p> connectors <c> remove

Removes the connector entry from settings.json.`

export const connectorsRemoveHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const connectorName = c.req.param("connector")!

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)

  findConnector(project, connectorName)

  const changed = await withPausedProject({
    projectId: project.id,
    isDaemonRunning: c.var.daemon.status().isRunning,
    control: new DaemonControlClient(),
    operation: () =>
      store.updateProject(project.id, (fresh) => ({
        ...fresh,
        connectors: fresh.connectors.filter((ch) => ch.name !== connectorName),
      })),
  })

  const tail = changed.wasPaused ? " (project runtime rebuilt)" : ""
  return c.text(`removed connector "${connectorName}"${tail}`)
})
