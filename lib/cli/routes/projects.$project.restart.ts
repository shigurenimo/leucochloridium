import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { waitForTenantDown } from "@/cli/utils/wait-for-tenant-down"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> restart / rebuild this project's tenant

usage / leuco projects <p> restart [--force]

Toggles enabled false->true around two SIGHUPs so the daemon stops + rebuilds
the tenant. Use this to pick up prompt edits, token changes, or to clear a
stuck codex process. The codex thread id is preserved.

options:
  --force / allow restarting the project from inside its own Codex session`

export const projectsRestartHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  if (!flagBool(body.flags.force) && isCurrentCodexProject(project)) {
    throw new HTTPException(400, { message: selfProjectGuardMessage(projectName, "restart") })
  }

  const wasEnabled = project.enabled

  // Patch `enabled` through updateProject rather than writing the snapshot
  // read above: the daemon persists codexThreadId / scheduleLastFiredAt at
  // its own cadence, and saving a stale whole-project object would roll that
  // state back (losing the conversation thread the help text promises to keep).
  store.updateProject(project.id, (fresh) => ({ ...fresh, enabled: false }))
  c.var.daemon.reload()

  const confirmedDown = await waitForTenantDown(project.id)

  store.updateProject(project.id, (fresh) => ({ ...fresh, enabled: true }))
  const reload = c.var.daemon.reload()

  const tail = wasEnabled ? "" : " (was disabled; ended up enabled)"
  const reloadMsg = reload.signalled ? "(daemon reloaded)" : "(daemon not running)"
  const warn = confirmedDown
    ? ""
    : "\nwarning: tenant did not stop within 10s; the restart may not have taken effect"
  return c.text(`restarted project "${projectName}"${tail} ${reloadMsg}${warn}`)
})
