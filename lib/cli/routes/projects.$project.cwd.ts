import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"
import { withPausedProject } from "@/cli/utils/with-paused-project"
import { DaemonControlClient } from "@/control/daemon-control-client"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> cwd / change the project runtime working directory

usage / leuco projects <p> cwd <path> [--force]

Changes the directory supplied to Codex without moving any repository files.
If the project runtime is running, leuco stops and rebuilds only that project runtime so the new
directory, trust entry, and project guidance take effect together.

options:
  --force / allow changing the project from inside its own Codex session

examples:
  leuco projects cocolococo-hiract cwd /Users/i/inta-backrooms
  leuco projects open-karte cwd ../inta-backrooms`

export const projectsCwdHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const rawPath = body.args[0]
  if (rawPath === undefined) {
    throw new HTTPException(400, { message: `usage: leuco projects ${projectName} cwd <path>` })
  }

  const nextPath = resolve(c.var.cwd, rawPath)
  if (!existsSync(nextPath)) {
    throw new HTTPException(400, { message: `working directory does not exist: ${nextPath}` })
  }
  if (!statSync(nextPath).isDirectory()) {
    throw new HTTPException(400, { message: `working directory is not a directory: ${nextPath}` })
  }

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)
  if (!flagBool(body.flags.force) && isCurrentCodexProject(project)) {
    throw new HTTPException(400, {
      message: selfProjectGuardMessage(projectName, "change cwd for"),
    })
  }
  if (project.path === nextPath) {
    return c.text(`project "${project.name}" already uses ${nextPath}`)
  }

  const changed = await withPausedProject({
    projectId: project.id,
    isDaemonRunning: c.var.daemon.status().isRunning,
    control: new DaemonControlClient(),
    operation: () =>
      store.updateProject(project.id, (fresh) => ({
        ...fresh,
        path: nextPath,
      })),
  })

  const tail = changed.wasPaused ? " (project runtime rebuilt)" : ""
  return c.text(`project "${project.name}" now runs in ${nextPath}${tail}`)
})
