import { HTTPException } from "hono/http-exception"
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
    throw new HTTPException(400, { message: `new name is identical to current name (${oldName})` })
  }

  validateLeucoName(newName, "agent name")

  const paths = new LeucoPaths()
  const store = new LeucoProjectStore({ paths })

  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  findAgent(project, oldName)

  if (project.agents.some((a) => a.name === newName)) {
    throw new HTTPException(400, { message: `agent already exists in ${projectName}: ${newName}` })
  }

  // 1. Rename the codex TOML inside the repo (keeps it as the source of truth
  // for codex's spawn_agent lookups; also updates `name = "..."` inside).
  const tomlStore = new LeucoCodexAgentStore({ cwd: project.path })
  tomlStore.rename("project", oldName, newName)

  // 2. Rename the codex-home directory so memories travel with the agent.
  const oldHome = paths.agentDir(project.id, oldName)
  const newHome = paths.agentDir(project.id, newName)
  if (existsSync(oldHome)) {
    if (existsSync(newHome)) {
      throw new HTTPException(500, { message: `target codex-home already exists: ${newHome}` })
    }
    renameSync(oldHome, newHome)
  }

  // 3. Update settings.json.
  store.save({
    ...project,
    agents: project.agents.map((a) => (a.name === oldName ? { ...a, name: newName } : a)),
  })

  return c.text(`renamed agent ${projectName}/${oldName} → ${newName}`)
})
