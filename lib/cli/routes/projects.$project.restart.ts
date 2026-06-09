import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { sleepReconcileGap } from "@/cli/utils/reconcile-gap"
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
    return c.text(selfProjectGuardMessage(projectName, "restart"), 400)
  }

  const wasEnabled = project.enabled

  store.save({ ...project, enabled: false })
  c.var.daemon.reload()

  await sleepReconcileGap()

  store.save({ ...project, enabled: true })
  const reload = c.var.daemon.reload()

  const tail = wasEnabled ? "" : " (was disabled; ended up enabled)"
  const reloadMsg = reload.signalled ? "(daemon reloaded)" : "(daemon not running)"
  return c.text(`restarted project "${projectName}"${tail} ${reloadMsg}`)
})
