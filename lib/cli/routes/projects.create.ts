import { basename, resolve } from "node:path"
import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import { validateLeucoName } from "@/cli/utils/validate-name"
import { LeucoProjectScaffolder, type ProjectScaffoldResult } from "@/projects/project-scaffolder"

const help = `leuco projects create — scaffold a new leuco-ready repository

usage: leuco projects create <path> [--name <name>]

  <path>          absolute or cwd-relative path of the new repository
  --name <name>   project identifier (default: basename of <path>); must match [a-z][a-z0-9_-]*

Steps performed (each is idempotent):
  - mkdir -p <path>
  - git init in <path> (skipped if already a repo)
  - register the project in ~/.leuco/config.json

Tokens, agent personas, and channel secrets are added separately:
  leuco projects <p> agents add <agent>
  leuco projects <p> agents <agent> channels add slack`

export const projectsCreateHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const rawPath = body.args[0]
  if (!rawPath) {
    throw new HTTPException(400, {
      message: "usage: leuco projects create <path> [--name <name>]",
    })
  }

  const path = resolve(c.var.cwd, rawPath)
  const name = flagString(body.flags.name) ?? basename(path)
  validateLeucoName(name, "project name")

  const scaffolder = new LeucoProjectScaffolder()
  const result = scaffolder.create({ path, name })

  return c.text(formatResult(result, name))
})

const formatResult = (result: ProjectScaffoldResult, name: string): string => {
  const header = result.steps.dir === "created" ? `created ${result.path}` : `ready ${result.path}`

  const lines = [
    header,
    `  dir       ${result.steps.dir}`,
    `  git       ${result.steps.git}`,
    `  project   ${result.steps.project}`,
    `  config    ${result.configPath}`,
    "",
    `next: leuco projects ${name} agents add <agent>`,
  ]

  return lines.join("\n")
}
