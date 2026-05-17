import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents list — list agents registered under a project

usage: leuco projects <p> agents list

Prints each agent on its own line: <name> <tab> channels=<count>.
A trailing "(toml missing)" indicates the project's .codex/agents/<name>.toml
is absent — drift between config and filesystem.`

export const agentsListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  if (project.agents.length === 0) return c.text("(no agents)")

  const tomlStore = new LeucoCodexAgentStore({ cwd: project.path })
  const tomlNames = new Set(tomlStore.list("project").map((entry) => entry.name))

  const lines = project.agents.map((agent) => {
    const state = agent.enabled ? "enabled" : "disabled"
    const drift = tomlNames.has(agent.name) ? "" : "\t(toml missing)"
    return `${agent.name}\t${state}\tchannels=${agent.channels.length}${drift}`
  })

  return c.text(lines.join("\n"))
})
