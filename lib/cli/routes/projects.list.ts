import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects list — list registered projects

usage: leuco projects list

Prints each project on its own line: <name> <tab> <path> [agents=<count>].
Reads from ~/.leuco/config.json.`

export const projectsListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const store = new LeucoProjectStore()
  const list = store.list()
  if (list instanceof Error) return c.text(`leuco: ${list.message}`, 500)

  if (list.length === 0) return c.text("(no projects)")

  const lines = list.map((p) => {
    const agents = p.agents.length > 0 ? ` agents=${p.agents.length}` : ""
    return `${p.name}\t${p.path}${agents}`
  })

  return c.text(lines.join("\n"))
})
