import type { LeucoDaemon } from "@/daemon/leuco-daemon"
import { LeucoProjectStore } from "@/projects/project-store"

export type StatusLines = {
  lines: string[]
  isRunning: boolean
}

/**
 * Build the multiline status output shared by `leuco status` and bare `leuco`.
 * Clears a stale pid file as a side-effect when one is found.
 */
export const formatStatus = (daemon: LeucoDaemon): StatusLines => {
  const status = daemon.status()
  const lines: string[] = []

  if (status.isRunning) {
    lines.push(`running (pid ${status.pid})`)
  } else if (status.pid !== null) {
    daemon.clearStalePid()
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

  return { lines, isRunning: status.isRunning }
}
