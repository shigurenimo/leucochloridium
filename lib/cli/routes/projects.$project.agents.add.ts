import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import type { Agent } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents add — register a leuco agent for a project

usage: leuco projects <p> agents add <name>

  <name>                  agent identifier ([a-z][a-z0-9_-]*)

Registers the agent in leuco's per-project settings so channels can attach to
it. Durable runtime instructions belong in the agent's CODEX_HOME/AGENTS.md.`

export const agentsAddHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = body.args[0]
  if (!agentName) {
    return c.text(`usage: leuco projects ${projectName} agents add <name>`, 400)
  }
  if (
    body.flags.description !== undefined ||
    body.flags.instructions !== undefined ||
    body.flags.model !== undefined
  ) {
    throw new HTTPException(400, {
      message:
        "--description, --instructions, and --model are not leuco agent settings; put durable instructions in CODEX_HOME/AGENTS.md",
    })
  }

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  if (project.agents.some((a) => a.name === agentName)) {
    throw new HTTPException(400, {
      message: `agent already exists in ${projectName}: ${agentName}`,
    })
  }

  const nextAgent: Agent = {
    name: agentName,
    enabled: true,
    useCommonInstructions: true,
    prompts: ["friendly"],
    channels: [],
    mcpServers: {},
  }
  store.save({ ...project, agents: [...project.agents, nextAgent] })

  return c.text(`added agent ${projectName}/${agentName}`)
})
