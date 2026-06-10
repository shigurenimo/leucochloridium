import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"
import { LeucoProjectStore } from "@/projects/project-store"

export const help = `leuco projects <p> session / show Codex session state

usage / leuco projects <p> session [subcommand]

subcommands:
  (none) / show current Codex thread id
  reset / clear Codex thread id and start a fresh session on the next turn`

export const projectsSessionHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  return c.text(
    renderYaml({
      project: project.name,
      codexThreadId: project.state.codexThreadId,
      hasSession: project.state.codexThreadId !== null,
      enabled: project.enabled,
    }),
  )
})
