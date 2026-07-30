import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"
import { DaemonControlClient } from "@/control/daemon-control-client"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> remove / unregister a project

usage / leuco projects <p> remove [--cascade] [--force]

options:
  --cascade / also remove the project's connectors from config
  --force / allow removing the project from inside its own Codex session

The registered project directory itself is not touched.
~/.leuco/projects/<id>/ (including the project's CODEX_HOME) is deleted.`

export const projectsRemoveHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const name = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, name)

  // Removing a project deletes its CODEX_HOME — an agent doing this to its
  // own project would erase its memory out from under the running codex.
  if (!flagBool(body.flags.force) && isCurrentCodexProject(project)) {
    throw new HTTPException(400, { message: selfProjectGuardMessage(name, "remove") })
  }

  const cascade = flagBool(body.flags.cascade)
  if (project.connectors.length > 0 && !cascade) {
    throw new HTTPException(400, {
      message: `project '${name}' has ${project.connectors.length} connector(s). use --cascade to remove with its connectors.`,
    })
  }

  const daemonRunning = c.var.daemon.status().isRunning
  const control = new DaemonControlClient()
  if (daemonRunning) {
    const paused = await control.pauseProject(project.id)
    if (!paused) {
      throw new HTTPException(503, {
        message: "daemon became unavailable before the project runtime was drained",
      })
    }
  }

  try {
    store.remove(project.id)
  } catch (error) {
    if (daemonRunning) await control.resumeProject(project.id).catch(() => false)
    throw error
  }

  if (daemonRunning) await control.reload()
  return c.text(`removed project "${name}"${daemonRunning ? " (runtime drained)" : ""}`)
})
