import { HTTPException } from "hono/http-exception"
import type { CliContext } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool } from "@/cli/utils/read-cli-body"
import type { CliBody } from "@/cli/utils/read-cli-body"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"
import { DaemonControlClient } from "@/control/daemon-control-client"
import { LeucoProjectStore } from "@/projects/project-store"
import { LeucoProjectStateStore } from "@/projects/project-state-store"

type Props = {
  help: string
  commandName: string
}

export const resetProjectSession = async (
  c: CliContext,
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

  const stateStore = new LeucoProjectStateStore({ paths: store.getPaths() })

  const daemonRunning = c.var.daemon.status().isRunning
  if (!daemonRunning || !project.enabled) {
    stateStore.clearCodexThreads(project.id)
    const activation = project.enabled
      ? " (daemon stopped; takes effect on next start)"
      : " (project disabled; takes effect on enable)"
    return c.text(`reset session for "${projectName}"${activation}`)
  }

  const reset = await new DaemonControlClient().resetProjectSession(project.id)
  if (!reset) throw new HTTPException(503, { message: "daemon control is unavailable" })

  return c.text(`reset session for "${projectName}"`)
}
