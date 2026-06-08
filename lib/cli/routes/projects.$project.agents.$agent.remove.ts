import { rmSync } from "node:fs"
import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { findAgent, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"
import { errorMessage } from "@/error-message"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> remove — delete a codex subagent

usage: leuco projects <p> agents <a> remove [--cascade]

  --cascade   also drop channels[] entries under this agent (config-only)

Deletes <project>/.codex/agents/<a>.toml and removes the agent from
~/.leuco/config.json. If the .toml is already missing, that is reported but
not treated as an error so config can be reconciled.`

export const agentsRemoveHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  const agent = findAgent(project, agentName)

  const cascade = flagBool(body.flags.cascade)
  if (agent.channels.length > 0 && !cascade) {
    throw new HTTPException(400, {
      message: `agent '${agentName}' has ${agent.channels.length} channel(s). use --cascade to remove with its channels.`,
    })
  }

  const tomlMessage = removeAgentToml(project.path, agentName)

  store.save({
    ...project,
    agents: project.agents.filter((a) => a.name !== agentName),
  })

  if (cascade) {
    const paths = new LeucoPaths()
    rmSync(paths.agentDir(project.id, agentName), { recursive: true, force: true })
  }

  return c.text(`removed agent ${projectName}/${agentName} ${tomlMessage}`)
})

// Remove `.codex/agents/<a>.toml`. A missing file is treated as a soft
// warning so config can still be reconciled when the toml was already
// cleaned up; any other failure (EACCES, EIO) is propagated so the user
// learns the toml was NOT removed instead of getting a misleading success.
const removeAgentToml = (projectPath: string, agentName: string): string => {
  const store = new LeucoCodexAgentStore({ cwd: projectPath })
  try {
    return store.remove("project", agentName)
  } catch (error) {
    const message = errorMessage(error)
    if (message.startsWith("agent not found:")) {
      return `(${message})`
    }
    throw error
  }
}
