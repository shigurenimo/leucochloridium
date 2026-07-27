import type { LeucoDaemon } from "@/daemon/leuco-daemon"
import { renderYaml } from "@/cli/utils/render-yaml"
import { LeucoProjectStore } from "@/projects/project-store"

type DaemonPort = Pick<LeucoDaemon, "clearStalePid" | "status">

type ProjectStorePort = Pick<LeucoProjectStore, "listRunnable">

export type StatusResult = {
  text: string
  isRunning: boolean
}

export const formatStatus = (
  daemon: DaemonPort,
  projectStore: ProjectStorePort = new LeucoProjectStore(),
): StatusResult => {
  const status = daemon.status()

  if (!status.isRunning && status.pid !== null) {
    daemon.clearStalePid()
  }

  const runnableProjects = projectStore.listRunnable()

  const report = {
    running: status.isRunning,
    ...(status.isRunning ? { pid: status.pid } : {}),
    log: status.logPath,
    projects: runnableProjects.projects.map((project) => ({
      name: project.name,
      enabled: project.enabled,
      channels: project.channels.filter((channel) => channel.enabled).length,
      path: project.path,
    })),
    ...(runnableProjects.issues.length > 0 ? { projectIssues: runnableProjects.issues } : {}),
  }

  return { text: renderYaml(report), isRunning: status.isRunning }
}
