import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"
import { stopProjectTenant } from "@/cli/utils/stop-project-tenant"
import { waitForTenantDown } from "@/cli/utils/wait-for-tenant-down"
import { errorMessage } from "@/error-message"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> cwd / change the tenant working directory

usage / leuco projects <p> cwd <path> [--force]

Changes the directory supplied to Codex without moving any repository files.
If the tenant is running, leuco stops and rebuilds only that tenant so the new
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
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  if (!flagBool(body.flags.force) && isCurrentCodexProject(project)) {
    throw new HTTPException(400, {
      message: selfProjectGuardMessage(projectName, "change cwd for"),
    })
  }
  if (project.path === nextPath) {
    return c.text(`project "${project.name}" already uses ${nextPath}`)
  }

  const stopped = await stopProjectTenant({
    projectId: project.id,
    store,
    daemon: c.var.daemon,
    waitForDown: waitForTenantDown,
  })
  if (stopped instanceof Error) {
    throw new HTTPException(503, { message: stopped.message })
  }

  try {
    store.updateProject(project.id, (fresh) => ({
      ...fresh,
      path: nextPath,
      enabled: stopped.disabledForStop ? true : fresh.enabled,
    }))
  } catch (err) {
    if (stopped.disabledForStop) {
      try {
        store.updateProject(project.id, (fresh) => ({ ...fresh, enabled: true }))
        c.var.daemon.reload()
      } catch {
        // Preserve the path update failure.
      }
    }
    throw new HTTPException(500, {
      message: `working directory update failed: ${errorMessage(err)}`,
    })
  }

  if (stopped.disabledForStop) {
    const reload = c.var.daemon.reload()
    if (!reload.signalled) {
      throw new HTTPException(503, {
        message: `working directory changed, but daemon restart signal failed for project '${project.name}'`,
      })
    }
  }

  const tail = stopped.disabledForStop ? " (tenant rebuilt)" : ""
  return c.text(`project "${project.name}" now runs in ${nextPath}${tail}`)
})
