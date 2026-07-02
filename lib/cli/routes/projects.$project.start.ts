import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> start / enable a project and reload daemon

usage / leuco projects <p> start

Sets enabled=true in settings.json. If the daemon is running, sends SIGHUP so
it reconciles tenants immediately. If stopped, takes effect on next \`leuco start\`.`

export const projectsStartHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  if (project.enabled) {
    return c.text(`project "${projectName}" is already enabled`)
  }

  store.updateProject(project.id, (fresh) => ({ ...fresh, enabled: true }))

  const reload = c.var.daemon.reload()
  const reloadMsg = reload.signalled
    ? `(daemon reloaded, pid ${reload.pid})`
    : "(daemon not running; takes effect on next `leuco start`)"

  return c.text(`enabled project "${projectName}" ${reloadMsg}`)
})
