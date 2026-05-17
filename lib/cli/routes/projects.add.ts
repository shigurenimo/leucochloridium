import { basename, resolve } from "node:path"
import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import type { Project } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects add — register an existing repository with leuco

usage: leuco projects add [<path>] [--name <name>]

  <path>          absolute or cwd-relative path to the repository root
                  (default: current working directory)
  --name <name>   project identifier (default: basename of <path>)

Persists into ~/.leuco/config.json under "projects". The path itself is left
untouched. Use \`leuco projects create\` to scaffold a new repository instead.`

export const projectsAddHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const rawPath = body.args[0]
  const path = rawPath ? resolve(c.var.cwd, rawPath) : c.var.cwd
  const name = flagString(body.flags.name) ?? basename(path)

  const store = new LeucoProjectStore()
  const list = store.list()

  if (list.some((p) => p.path === path)) {
    throw new HTTPException(400, {
      message: `another project is already registered at ${path}`,
    })
  }

  const project: Project = { id: crypto.randomUUID(), name, path, agents: [] }
  store.save(project)

  return c.text(`added project ${name} → ${path}`)
})
