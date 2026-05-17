import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco status — show daemon status

usage: leuco status

Prints whether the per-cwd daemon is running, plus the pid and log path.

exit codes:
  0  running
  1  not running (or stale pid file cleared)`

export const statusHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const status = c.var.daemon.status()
  const lines: string[] = []

  if (status.isRunning) {
    lines.push(`running (pid ${status.pid})`)
  } else if (status.pid !== null) {
    c.var.daemon.clearStalePid()
    lines.push(`not running (stale pid file: ${status.pid}, cleared)`)
  } else {
    lines.push("not running")
  }
  lines.push(`  log: ${status.logPath}`)

  const store = new LeucoProjectStore()
  const projects = store.list()
  if (projects.length === 0) {
    lines.push("", "projects: (none registered)")
  } else {
    lines.push("", "projects:")
    for (const project of projects) {
      const enabledAgents = project.agents.filter((a) => a.enabled).length
      const totalAgents = project.agents.length
      lines.push(`  ${project.name}\tagents=${enabledAgents}/${totalAgents}\t${project.path}`)
    }
  }

  return c.text(lines.join("\n"), status.isRunning ? 200 : 503)
})
