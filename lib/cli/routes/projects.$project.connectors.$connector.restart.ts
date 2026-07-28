import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { findConnector, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"
import { DaemonControlClient } from "@/control/daemon-control-client"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> connectors <c> restart / reload a connector

usage / leuco projects <p> connectors <c> restart [--force]

Asks the daemon to rebuild only this connector from the latest settings.
The Codex process and other connectors keep running.

options:
  --force / allow restarting the connector from inside its parent Codex session`

export const connectorsRestartHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const connectorName = c.req.param("connector")!

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)
  if (!flagBool(body.flags.force) && isCurrentCodexProject(project)) {
    throw new HTTPException(400, {
      message: selfProjectGuardMessage(projectName, `restart connector "${connectorName}" for`),
    })
  }

  const connector = findConnector(project, connectorName)

  if (!project.enabled) {
    throw new HTTPException(400, { message: `project is disabled: ${projectName}` })
  }
  if (!connector.enabled) {
    throw new HTTPException(400, { message: `connector is disabled: ${connectorName}` })
  }

  const restarted = await new DaemonControlClient().restartConnector(project.id, connector.name)
  if (!restarted) {
    throw new HTTPException(503, { message: "daemon is not running" })
  }

  return c.text(`restarted connector "${connectorName}"`)
})
