import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects — list registered projects

usage:
  leuco projects                                   list registered projects
  leuco projects create <path>                     scaffold a new repository
  leuco projects add [<path>]                      register an existing repository
  leuco projects <p> remove [--cascade]            unregister a project
  leuco projects <p> rename <new>                  rename a project
  leuco projects <p> agents ...                    manage agents under a project

Each row prints \`<name> <tab> <path> [agents=<count>]\`.

Run \`leuco projects <subcommand> -h\` for details on a specific subcommand.`

export const projectsListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const store = new LeucoProjectStore()
  const list = store.list()

  if (list.length === 0) return c.text("(no projects)")

  const lines = list.map((p) => {
    const agents = p.agents.length > 0 ? ` agents=${p.agents.length}` : ""
    return `${p.name}\t${p.path}${agents}`
  })

  return c.text(lines.join("\n"))
})
