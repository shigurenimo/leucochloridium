import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { validateLeucoName } from "@/cli/utils/validate-name"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> rename / change a project's display name

usage / leuco projects <p> rename <new-name>

The on-disk directory is keyed by UUID, so nothing moves under ~/.leuco/projects/.
Same-name projects are allowed; the CLI disambiguates by cwd.`

export const projectsRenameHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const oldName = c.req.param("project")!
  const newName = body.args[0]
  if (!newName) {
    throw new HTTPException(400, {
      message: `usage: leuco projects ${oldName} rename <new-name>`,
    })
  }
  if (newName === oldName) {
    throw new HTTPException(400, { message: `new name is identical to current name (${oldName})` })
  }

  validateLeucoName(newName, "project name")

  const store = new LeucoProjectStore()
  const project = resolveProject(store, oldName, { preferCwd: c.var.cwd })

  store.save({ ...project, name: newName })

  return c.text(`renamed project "${oldName}" to "${newName}"`)
})
