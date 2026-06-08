import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> stop / disable a project and reload daemon

usage / leuco projects <p> stop

Sets enabled=false in settings.json. The project definition (.codex, channels)
is preserved -- re-enable with \`leuco projects <p> start\`.`

export const projectsStopHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  if (!project.enabled) {
    return c.text(`project "${projectName}" is already disabled`)
  }

  store.save({ ...project, enabled: false })

  const reload = c.var.daemon.reload()
  const reloadMsg = reload.signalled
    ? `(daemon reloaded, pid ${reload.pid})`
    : "(daemon not running)"

  return c.text(`disabled project "${projectName}" ${reloadMsg}`)
})
