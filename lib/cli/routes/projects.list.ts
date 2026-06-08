import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects / manage registered projects

usage / leuco projects [subcommand]

subcommands:
  (none) / list every project
  create <path> / scaffold + register a new repo
  add [<path>] / register an existing repo
  <p> / project operations (run \`leuco projects <p> -h\`)`

export const projectsListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const store = new LeucoProjectStore()
  const list = store.list()

  return c.text(
    renderYaml({
      projects: list.map((p) => ({
        name: p.name,
        enabled: p.enabled,
        path: p.path,
        channels: p.channels.length,
      })),
    }),
  )
})
