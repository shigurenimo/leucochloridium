import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects remove — unregister a project

usage: leuco projects <name> remove [--cascade]

  --cascade   also remove the project's agents (and their channels) from config

Updates ~/.leuco/config.json. The project directory itself is not touched, and
existing .codex/agents/*.toml files inside the repository are left in place.`

export const projectsRemoveHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const name = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = store.load(name)
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const cascade = flagBool(body.flags.cascade)
  if (project.agents.length > 0 && !cascade) {
    return c.text(
      `leuco: project '${name}' has ${project.agents.length} agent(s). use --cascade to remove with its agents and channels.`,
      400,
    )
  }

  store.remove(name)
  return c.text(`removed project ${name}`)
})
