import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import type { Env } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool } from "@/cli/utils/read-cli-body"
import type { CliBody } from "@/cli/utils/read-cli-body"
import { waitForTenantDown } from "@/cli/utils/wait-for-tenant-down"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"
import { LeucoProjectStore } from "@/projects/project-store"

type Props = {
  help: string
  commandName: string
}

export const resetProjectSession = async (
  c: Context<Env>,
  body: CliBody,
  props: Props,
): Promise<Response> => {
  if (flagBool(body.flags.help)) return c.text(props.help)

  const projectName = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)
  if (!flagBool(body.flags.force) && isCurrentCodexProject(project)) {
    throw new HTTPException(400, {
      message: selfProjectGuardMessage(projectName, props.commandName),
    })
  }

  const previousThreadId = project.state.codexThreadId
  const previousThreadCount = Object.keys(project.state.codexThreadIds).length

  // Every write goes through updateProject so a concurrent daemon-side state
  // write (markScheduleEntryFired etc.) is never rolled back by a stale
  // snapshot of the project.
  store.updateProject(project.id, (fresh) => ({
    ...fresh,
    state: { ...fresh.state, codexThreadId: null, codexThreadIds: {} },
  }))

  if (!project.enabled) {
    const wasEmpty = previousThreadId === null && previousThreadCount === 0
    const tail = wasEmpty
      ? " (was already empty)"
      : ` (cleared ${previousThreadCount + (previousThreadId === null ? 0 : 1)} thread ids)`
    return c.text(
      `reset session for "${projectName}"${tail} (project disabled; takes effect on enable)`,
    )
  }

  store.updateProject(project.id, (fresh) => ({ ...fresh, enabled: false }))
  const stopReload = c.var.daemon.reload()

  const confirmedDown = stopReload.signalled ? await waitForTenantDown(project.id) : true

  store.updateProject(project.id, (fresh) => ({ ...fresh, enabled: true }))
  const reload = c.var.daemon.reload()

  const reloadMsg = reload.signalled ? "(daemon reloaded)" : "(daemon not running)"
  const clearedCount = previousThreadCount + (previousThreadId === null ? 0 : 1)
  const previousMsg = clearedCount === 0 ? "" : ` cleared=${clearedCount}`
  const warn = confirmedDown
    ? ""
    : "\nwarning: tenant did not stop within 10s; the reset may not have taken effect"

  return c.text(`reset session for "${projectName}"${previousMsg} ${reloadMsg}${warn}`)
}
