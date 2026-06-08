import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { sleepReconcileGap } from "@/cli/utils/reconcile-gap"
import { LeucoProjectStore } from "@/projects/project-store"
import { LeucoProjectStateStore } from "@/projects/project-state-store"

const help = `leuco projects <p> reset / drop the codex thread id

usage / leuco projects <p> reset

Clears codexThreadId in state.json so the next turn starts a fresh codex
thread. Codex memories under .codex/memory/ are kept. If the project is
enabled, the tenant is restarted so the in-memory thread id is also discarded.`

export const projectsResetHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  const stateStore = new LeucoProjectStateStore({ paths: store.getPaths() })
  const previousThreadId = stateStore.load(project.id).codexThreadId
  stateStore.setCodexThreadId(project.id, null)

  if (!project.enabled) {
    const tail = previousThreadId === null ? " (was already empty)" : ` (was ${previousThreadId})`
    return c.text(
      `reset thread for "${projectName}"${tail} (project disabled; takes effect on enable)`,
    )
  }

  const reloaded = store.load(project.id)

  store.save({ ...reloaded, enabled: false })
  c.var.daemon.reload()

  await sleepReconcileGap()

  store.save({ ...reloaded, enabled: true })
  const reload = c.var.daemon.reload()

  const reloadMsg = reload.signalled ? "(daemon reloaded)" : "(daemon not running)"
  const previousMsg = previousThreadId === null ? "" : ` previous=${previousThreadId}`

  return c.text(`reset thread for "${projectName}"${previousMsg} ${reloadMsg}`)
})
