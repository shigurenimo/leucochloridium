import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"
import type { ConversationScope } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> session scope / show or change conversation routing

usage / leuco projects <p> session scope [project|thread] [--force]

scopes:
  project / share one Codex conversation across every Slack thread and schedule
  thread / keep a separate Codex conversation for each connector-provided threadKey

Changing scope preserves both sets of saved thread ids, so switching back restores
the previous conversation history. A running project runtime is rebuilt automatically.

options:
  --force / allow changing scope from inside this project's own Codex session`

export const projectsSessionScopeHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)
  const requested = body.args[0]
  if (requested === undefined) {
    return c.text(project.conversationScope)
  }
  if (requested !== "project" && requested !== "thread") {
    throw new HTTPException(400, {
      message: "scope must be one of: project, thread",
    })
  }
  const nextScope: ConversationScope = requested
  if (nextScope === project.conversationScope) {
    return c.text(`project "${project.name}" already uses ${nextScope} conversation scope`)
  }
  if (!flagBool(body.flags.force) && isCurrentCodexProject(project)) {
    throw new HTTPException(400, {
      message: selfProjectGuardMessage(projectName, "change conversation scope for"),
    })
  }

  store.updateProject(project.id, (fresh) => ({
    ...fresh,
    conversationScope: nextScope,
  }))
  const reload = c.var.daemon.reload()
  const tail = reload.signalled
    ? " (project runtime rebuild requested)"
    : " (takes effect on next start)"
  return c.text(`project "${project.name}" conversation scope set to ${nextScope}${tail}`)
})
