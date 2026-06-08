import type { LeucoDaemon } from "@/daemon/leuco-daemon"
import { renderYaml } from "@/cli/utils/render-yaml"
import { LeucoProjectStore } from "@/projects/project-store"

export type StatusResult = {
  text: string
  isRunning: boolean
}

export const formatStatus = (daemon: LeucoDaemon): StatusResult => {
  const status = daemon.status()

  if (!status.isRunning && status.pid !== null) {
    daemon.clearStalePid()
  }

  const store = new LeucoProjectStore()
  const projects = store.list()

  const report = {
    running: status.isRunning,
    ...(status.isRunning ? { pid: status.pid } : {}),
    log: status.logPath,
    projects: projects.map((p) => ({
      name: p.name,
      enabled: p.enabled,
      channels: p.channels.filter((c) => c.enabled).length,
      path: p.path,
    })),
  }

  return { text: renderYaml(report), isRunning: status.isRunning }
}
