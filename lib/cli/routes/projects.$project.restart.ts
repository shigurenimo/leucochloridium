import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"
import { DaemonControlClient } from "@/control/daemon-control-client"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> restart / rebuild this project's project runtime

usage / leuco projects <p> restart [--force]

Asks the daemon to replace this project's runtime in one atomic operation.
Use this to pick up prompt edits, token changes, or to clear a stuck Codex
process. The Codex thread id and enabled state are preserved.

options:
  --force / allow restarting the project from inside its own Codex session`

export const projectsRestartHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)
  if (!flagBool(body.flags.force) && isCurrentCodexProject(project)) {
    throw new HTTPException(400, { message: selfProjectGuardMessage(projectName, "restart") })
  }

  if (!project.enabled) {
    throw new HTTPException(400, { message: `project is disabled: ${projectName}` })
  }

  const restarted = await new DaemonControlClient().restartProject(project.id)
  if (!restarted) {
    throw new HTTPException(503, { message: "daemon is not running" })
  }

  return c.text(`restarted project "${projectName}"`)
})
