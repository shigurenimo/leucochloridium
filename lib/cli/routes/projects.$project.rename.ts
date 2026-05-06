import { existsSync, renameSync } from "node:fs"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { validateLeucoName } from "@/cli/utils/validate-name"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> rename — change a project's identifier

usage: leuco projects <p> rename <new-name>

  <new-name>   new identifier; must match ^[a-z][a-z0-9_-]*$

Renames the directory under ~/.leuco/projects/<old>/ to <new>/ and updates
the \`name\` field inside settings.json. The repository path itself and any
\`.codex/agents/*.toml\` files in the repo are not touched.

The daemon must be stopped first; \`leuco run\` from this project's cwd will
otherwise still see the project under its old paths until restart.`

export const projectsRenameHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const oldName = c.req.param("project")!
  const newName = body.args[0]
  if (!newName) {
    return c.text(`usage: leuco projects ${oldName} rename <new-name>`, 400)
  }
  if (newName === oldName) {
    return c.text(`leuco: new name is identical to current name (${oldName})`, 400)
  }

  const validated = validateLeucoName(newName, "project name")
  if (validated instanceof Error) return c.text(`leuco: ${validated.message}`, 400)

  const paths = new LeucoPaths()
  const store = new LeucoProjectStore({ paths })

  const project = store.load(oldName)
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  if (existsSync(paths.projectSettingsPath(newName))) {
    return c.text(`leuco: project already exists: ${newName}`, 400)
  }

  renameSync(paths.projectDir(oldName), paths.projectDir(newName))

  const saved = store.save({ ...project, name: newName })
  if (saved instanceof Error) return c.text(`leuco: ${saved.message}`, 500)

  return c.text(`renamed project ${oldName} → ${newName}`)
})
