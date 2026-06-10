import type { Context } from "hono"
import type { Env } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool } from "@/cli/utils/read-cli-body"
import type { CliBody } from "@/cli/utils/read-cli-body"
import { sleepReconcileGap } from "@/cli/utils/reconcile-gap"
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
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  if (!flagBool(body.flags.force) && isCurrentCodexProject(project)) {
    return c.text(selfProjectGuardMessage(projectName, props.commandName), 400)
  }

  const previousThreadId = project.state.codexThreadId
  store.save({ ...project, state: { ...project.state, codexThreadId: null } })

  if (!project.enabled) {
    const tail = previousThreadId === null ? " (was already empty)" : ` (was ${previousThreadId})`
    return c.text(
      `reset session for "${projectName}"${tail} (project disabled; takes effect on enable)`,
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

  return c.text(`reset session for "${projectName}"${previousMsg} ${reloadMsg}`)
}
