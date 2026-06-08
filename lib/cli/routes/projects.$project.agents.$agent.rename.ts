import { HTTPException } from "hono/http-exception"
import { existsSync, renameSync } from "node:fs"
import { factory } from "@/cli/cli-factory"
import { findAgent, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { validateLeucoName } from "@/cli/utils/validate-name"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"
import { errorMessage } from "@/error-message"
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
    throw new HTTPException(400, {
      message: `usage: leuco projects ${projectName} agents ${oldName} rename <new-name>`,
    })
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

  // Stop the daemon before touching CODEX_HOME so the running codex child does
  // not race the rename or hold files open in the old directory. Restart after
  // the move if it was running on entry.
  const daemon = c.var.daemon
  const wasRunning = daemon.status().isRunning
  if (wasRunning) daemon.stop()

  // Track which of the three rename steps succeeded so we can roll back in
  // reverse on failure. Without this a step-2 failure leaves the TOML under
  // the new name while settings.json still references the old one (and the
  // codex-home dir is half-moved).
  let tomlRenamed = false
  let homeRenamed = false
  const tomlStore = new LeucoCodexAgentStore({ cwd: project.path })
  const oldHome = paths.agentDir(project.id, oldName)
  const newHome = paths.agentDir(project.id, newName)

  try {
    // 1. Rename the codex TOML inside the repo (keeps it as the source of truth
    // for codex's spawn_agent lookups; also updates `name = "..."` inside).
    tomlStore.rename("project", oldName, newName)
    tomlRenamed = true

    // 2. Rename the codex-home directory so memories travel with the agent.
    if (existsSync(oldHome)) {
      if (existsSync(newHome)) {
        throw new HTTPException(500, { message: `target codex-home already exists: ${newHome}` })
      }
      renameSync(oldHome, newHome)
      homeRenamed = true
    }

    // 3. Update settings.json.
    store.save({
      ...project,
      agents: project.agents.map((a) => (a.name === oldName ? { ...a, name: newName } : a)),
    })

    const lines = [`renamed agent ${projectName}/${oldName} → ${newName}`]
    if (wasRunning) {
      const result = daemon.start({ binPath: c.var.binPath, env: process.env })
      lines.push(`daemon restarted (pid ${result.pid})`)
    }
    return c.text(lines.join("\n"))
  } catch (error) {
    if (homeRenamed) {
      try {
        renameSync(newHome, oldHome)
      } catch (rollbackError) {
        process.stderr.write(
          `[leuco] rename rollback: codex-home stranded at ${newHome}: ${errorMessage(rollbackError)}\n`,
        )
      }
    }
    if (tomlRenamed) {
      try {
        tomlStore.rename("project", newName, oldName)
      } catch (rollbackError) {
        process.stderr.write(
          `[leuco] rename rollback: toml stranded as ${newName}: ${errorMessage(rollbackError)}\n`,
        )
      }
    }
    if (wasRunning && !daemon.status().isRunning) {
      daemon.start({ binPath: c.var.binPath, env: process.env })
    }
    throw error
  }
})
