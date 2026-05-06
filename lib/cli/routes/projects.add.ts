import { basename, resolve } from "node:path"
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
  if (list instanceof Error) return c.text(`leuco: ${list.message}`, 500)

  if (list.some((p) => p.name === name)) {
    return c.text(`leuco: project already exists: ${name}`, 400)
  }
  if (list.some((p) => p.path === path)) {
    return c.text(`leuco: another project is already registered at ${path}`, 400)
  }

  const project: Project = { name, path, agents: [] }
  const saved = store.save(project)
  if (saved instanceof Error) return c.text(`leuco: ${saved.message}`, 500)

  return c.text(`added project ${name} → ${path}`)
})
