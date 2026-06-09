import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents — list agents under a project

usage:
  leuco projects <p> agents                        list agents in this project
  leuco projects <p> agents add <a>                add an agent
  leuco projects <p> agents <a> remove [--cascade] remove an agent
  leuco projects <p> agents <a> rename <new>       rename an agent
  leuco projects <p> agents <a> move-to <dst>      move an agent to another project
  leuco projects <p> agents <a> channels ...       manage channels under an agent

Each row prints \`<name> <tab> <state> <tab> channels=<count>\`. A trailing

Run \`leuco projects <p> agents <subcommand> -h\` for details on a specific subcommand.`

export const agentsListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  if (project.agents.length === 0) return c.text("(no agents)")

  const lines = project.agents.map((agent) => {
    const state = agent.enabled ? "enabled" : "disabled"
    return `${agent.name}\t${state}\tchannels=${agent.channels.length}`
  })

  return c.text(lines.join("\n"))
})
