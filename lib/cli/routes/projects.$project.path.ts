import { HTTPException } from "hono/http-exception"
import { join } from "node:path"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> path / print project filesystem paths

usage / leuco projects <p> path [key]

keys:
  (none), home, codex / project CODEX_HOME
  agents / project AGENTS.md
  runtime, project / project runtime directory under ~/.leuco/projects
  repo / registered repository path

examples:
  leuco projects azamino path
  leuco projects azamino path agents`

export const projectsPathHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const key = body.args[0] ?? "home"

  const paths = new LeucoPaths()
  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  if (key === "home" || key === "codex") {
    return c.text(`${paths.projectHome(project.id)}\n`)
  }
  if (key === "agents") {
    return c.text(`${join(paths.projectHome(project.id), "AGENTS.md")}\n`)
  }
  if (key === "runtime" || key === "project") {
    return c.text(`${paths.projectDir(project.id)}\n`)
  }
  if (key === "repo") {
    return c.text(`${project.path}\n`)
  }

  throw new HTTPException(400, { message: `unknown project path key: ${key}` })
})
