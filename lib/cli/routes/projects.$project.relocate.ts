import { existsSync, renameSync } from "node:fs"
import { basename, resolve } from "node:path"
import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { validateLeucoName } from "@/cli/utils/validate-name"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> relocate — move the repository directory

usage: leuco projects <p> relocate <new-path> [--rename false]

  <new-path>        absolute or cwd-relative path the repo will live at
  --rename false    keep the current project name; default also renames
                    the project to basename(<new-path>)

Moves the on-disk repository (\`mv <old> <new>\`) and updates the project's
\`path\` field in settings.json. The daemon is automatically stopped before
the move and restarted afterwards, so codex children pick up the new path
(written into each tenant's CODEX_HOME config.toml as
\`[projects.<path>] trust_level = "trusted"\`).

The target directory must not already exist; if it does, run the move
manually and use \`leuco projects add\` to re-register. To rename without
relocating, use \`leuco projects <p> rename\` instead.`

export const projectsRelocateHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const oldName = c.req.param("project")!
  const rawNewPath = body.args[0]
  if (!rawNewPath) {
    throw new HTTPException(400, {
      message: `usage: leuco projects ${oldName} relocate <new-path> [--rename false]`,
    })
  }

  const newPath = resolve(c.var.cwd, rawNewPath)
  // `--rename` is on by default; `--rename false` opts out. Bare `--rename`
  // also stays on.
  const renameFlag = body.flags.rename
  const shouldRename = renameFlag === "false" || renameFlag === false ? false : true

  const store = new LeucoProjectStore()
  const project = resolveProject(store, oldName, { preferCwd: c.var.cwd })

  if (newPath === project.path) {
    throw new HTTPException(400, {
      message: `new path is identical to current path (${project.path})`,
    })
  }
  if (!existsSync(project.path)) {
    throw new HTTPException(400, {
      message: `source path does not exist: ${project.path}`,
    })
  }
  if (existsSync(newPath)) {
    throw new HTTPException(400, {
      message: `target path already exists: ${newPath}`,
    })
  }

  const list = store.list()
  if (list.some((p) => p.id !== project.id && p.path === newPath)) {
    throw new HTTPException(400, {
      message: `another project is already registered at ${newPath}`,
    })
  }

  let newName = project.name
  if (shouldRename) {
    const candidate = basename(newPath)
    if (candidate !== project.name) {
      validateLeucoName(candidate, "project name")
      newName = candidate
    }
  }

  // Stop the daemon before moving so running codex children don't hold the
  // old cwd open. Restart only if it was running originally.
  const daemon = c.var.daemon
  const wasRunning = daemon.status().isRunning
  if (wasRunning) daemon.stop()

  renameSync(project.path, newPath)
  store.save({ ...project, path: newPath, name: newName })

  const lines = [
    newName === project.name
      ? `relocated project ${oldName}: ${project.path} → ${newPath}`
      : `relocated project ${oldName} → ${newName}: ${project.path} → ${newPath}`,
  ]
  if (wasRunning) {
    const result = daemon.start({ binPath: c.var.binPath, env: process.env })
    lines.push(`daemon restarted (pid ${result.pid})`)
  }
  return c.text(lines.join("\n"))
})
