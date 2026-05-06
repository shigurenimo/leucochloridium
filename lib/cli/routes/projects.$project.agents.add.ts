import { factory } from "@/cli/cli-factory"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import type { Agent } from "@/config/config-schema"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents add — create a codex subagent for a project

usage: leuco projects <p> agents add <name> [--description <text>] [--instructions <text>] [--model <id>]

  <name>                  agent identifier ([a-z][a-z0-9_-]*)
  --description <text>    one-line summary of when codex should use this agent
  --instructions <text>   developer_instructions body (multi-line allowed)
  --model <id>            override the default model for this agent

Writes <project>/.codex/agents/<name>.toml (consumed by codex itself) and
registers the agent in ~/.leuco/config.json under the project so channels can
attach to it. Edit further fields directly in the generated file.

See https://developers.openai.com/codex/subagents for the full TOML spec.`

export const agentsAddHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = body.args[0]
  if (!agentName) {
    return c.text(
      `usage: leuco projects ${projectName} agents add <name> [--description <text>] [--instructions <text>] [--model <id>]`,
      400,
    )
  }

  const description = flagString(body.flags.description) ?? `Codex agent: ${agentName}`
  const developerInstructions =
    flagString(body.flags.instructions) ??
    `You are the ${agentName} agent. Replace this with real guidance.`
  const model = flagString(body.flags.model)

  const store = new LeucoProjectStore()
  const project = store.load(projectName)
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  if (project.agents.some((a) => a.name === agentName)) {
    return c.text(`leuco: agent already exists in ${projectName}: ${agentName}`, 400)
  }

  // Write the codex TOML inside the project's repo so codex itself can read it.
  const tomlStore = new LeucoCodexAgentStore({ cwd: project.path })
  const tomlPath = tomlStore.add({
    scope: "project",
    name: agentName,
    description,
    developerInstructions,
    model,
  })
  if (tomlPath instanceof Error) return c.text(`leuco: ${tomlPath.message}`, 400)

  const nextAgent: Agent = { name: agentName, enabled: true, channels: [] }
  const saved = store.save({ ...project, agents: [...project.agents, nextAgent] })
  if (saved instanceof Error) return c.text(`leuco: ${saved.message}`, 500)

  return c.text(`added agent ${projectName}/${agentName} → ${tomlPath}`)
})
