import { rmSync } from "node:fs"
import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { findAgent, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> remove — unregister a leuco agent

usage: leuco projects <p> agents <a> remove [--cascade]

  --cascade   also drop channels[] entries under this agent (config-only)

Removes the agent from leuco's per-project settings.`

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

  store.save({
    ...project,
    agents: project.agents.filter((a) => a.name !== agentName),
  })

  if (cascade) {
    const paths = new LeucoPaths()
    rmSync(paths.agentDir(project.id, agentName), { recursive: true, force: true })
  }

  return c.text(`removed agent ${projectName}/${agentName}`)
})
