import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"
import { LeucoProjectStore } from "@/projects/project-store"

export const help = `leuco projects <p> session / show Codex session state

usage / leuco projects <p> session [subcommand]

subcommands:
  (none) / show the conversation scope and current Codex thread ids
  scope [project|thread] / show or change conversation routing
  reset / clear all Codex thread ids and start fresh sessions on the next turn`

export const projectsSessionHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  const activeThreadIds =
    project.conversationScope === "project"
      ? project.state.codexThreadId === null
        ? []
        : [project.state.codexThreadId]
      : Object.values(project.state.codexThreadIds)

  return c.text(
    renderYaml({
      project: project.name,
      conversationScope: project.conversationScope,
      codexThreadId: project.state.codexThreadId,
      codexThreadIds: project.state.codexThreadIds,
      activeSessionCount: activeThreadIds.length,
      hasSession: activeThreadIds.length > 0,
      enabled: project.enabled,
    }),
  )
})
