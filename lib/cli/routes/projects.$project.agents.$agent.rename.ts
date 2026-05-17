import { existsSync, renameSync } from "node:fs"
import { factory } from "@/cli/cli-factory"
import { findAgent, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { validateLeucoName } from "@/cli/utils/validate-name"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> rename — change an agent's identifier

usage: leuco projects <p> agents <a> rename <new-name>

  <new-name>   new identifier; must match ^[a-z][a-z0-9_-]*$

Renames the agent in three places at once:
  - settings.json's agents[i].name
  - <project>/.codex/agents/<old>.toml → <new>.toml (\`name\` inside also updated)
  - ~/.leuco/projects/<p>/agents/<old>/ → <new>/ (codex-home, including memories)

Memories survive the rename. The daemon must be stopped first because the
running codex child holds CODEX_HOME at the old path.`

export const agentsRenameHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const oldName = c.req.param("agent")!
  const newName = body.args[0]
  if (!newName) {
    return c.text(`usage: leuco projects ${projectName} agents ${oldName} rename <new-name>`, 400)
  }
  if (newName === oldName) {
    return c.text(`leuco: new name is identical to current name (${oldName})`, 400)
  }

  const validated = validateLeucoName(newName, "agent name")
  if (validated instanceof Error) return c.text(`leuco: ${validated.message}`, 400)

  const paths = new LeucoPaths()
  const store = new LeucoProjectStore({ paths })

  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, oldName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  if (project.agents.some((a) => a.name === newName)) {
    return c.text(`leuco: agent already exists in ${projectName}: ${newName}`, 400)
  }

  // 1. Rename the codex TOML inside the repo (keeps it as the source of truth
  // for codex's spawn_agent lookups; also updates `name = "..."` inside).
  const tomlStore = new LeucoCodexAgentStore({ cwd: project.path })
  const tomlResult = tomlStore.rename("project", oldName, newName)
  if (tomlResult instanceof Error) return c.text(`leuco: ${tomlResult.message}`, 500)

  // 2. Rename the codex-home directory so memories travel with the agent.
  const oldHome = paths.agentDir(project.id, oldName)
  const newHome = paths.agentDir(project.id, newName)
  if (existsSync(oldHome)) {
    if (existsSync(newHome)) {
      return c.text(`leuco: target codex-home already exists: ${newHome}`, 500)
    }
    renameSync(oldHome, newHome)
  }

  // 3. Update settings.json.
  const saved = store.save({
    ...project,
    agents: project.agents.map((a) => (a.name === oldName ? { ...a, name: newName } : a)),
  })
  if (saved instanceof Error) return c.text(`leuco: ${saved.message}`, 500)

  return c.text(`renamed agent ${projectName}/${oldName} → ${newName}`)
})
