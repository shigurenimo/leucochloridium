import { existsSync, renameSync } from "node:fs"
import { basename, resolve } from "node:path"
import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { validateLeucoName } from "@/cli/utils/validate-name"
import { errorMessage } from "@/error-message"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> relocate / move the repository directory

usage / leuco projects <p> relocate <new-path> [--rename false]

options:
  <new-path> / absolute or cwd-relative path the repo will live at
  --rename false / keep the current project name (default: also rename to basename)

Moves the on-disk repository and updates settings.json. The daemon is stopped
before the move and restarted afterwards. The target must not already exist.`

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

  try {
    renameSync(project.path, newPath)
    try {
      store.save({ ...project, path: newPath, name: newName })
    } catch (saveError) {
      // settings.json write failed after the directory move succeeded — roll
      // back the rename so the on-disk repo matches the persisted record.
      try {
        renameSync(newPath, project.path)
      } catch (rollbackError) {
        process.stderr.write(
          `[leuco] relocate rollback: repo stranded at ${newPath}: ${errorMessage(rollbackError)}\n`,
        )
      }
      throw saveError
    }

    const lines = [
      newName === project.name
        ? `relocated project "${oldName}": ${project.path} -> ${newPath}`
        : `relocated project "${oldName}" to "${newName}": ${project.path} -> ${newPath}`,
    ]
    if (wasRunning) {
      const result = daemon.start({ binPath: c.var.binPath, env: process.env })
      lines.push(`daemon restarted (pid ${result.pid})`)
    }
    return c.text(lines.join("\n"))
  } catch (error) {
    // Restore daemon even when the rename / save failed so the user is not
    // left with a silently-stopped supervisor.
    if (wasRunning && !daemon.status().isRunning) {
      daemon.start({ binPath: c.var.binPath, env: process.env })
    }
    throw error
  }
})
