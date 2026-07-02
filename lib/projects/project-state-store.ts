import type { ProjectState } from "@/config/config-schema"
import type { LeucoProjectStore } from "@/projects/project-store"

export type { ProjectState }

type Props = {
  projectStore: LeucoProjectStore
}

/**
 * Read / write the per-project runtime state (codexThreadId,
 * scheduleLastFiredAt) stored inside the unified `~/.leuco/settings.json`.
 * Thin wrapper over `LeucoProjectStore` — reads the project, patches the
 * `state` field, and saves back.
 */
export class LeucoProjectStateStore {
  private readonly projectStore: LeucoProjectStore

  constructor(props: Props) {
    this.projectStore = props.projectStore
    Object.freeze(this)
  }

  load(projectId: string): ProjectState {
    const project = this.projectStore.load(projectId)
    return project.state
  }

  setCodexThreadId(projectId: string, codexThreadId: string | null): void {
    this.projectStore.updateProject(projectId, (project) => ({
      ...project,
      state: { ...project.state, codexThreadId },
    }))
  }

  markScheduleEntryFired(projectId: string, entryId: string, firedAt: number): void {
    this.projectStore.updateProject(projectId, (project) => ({
      ...project,
      state: {
        ...project.state,
        scheduleLastFiredAt: { ...project.state.scheduleLastFiredAt, [entryId]: firedAt },
      },
    }))
  }
}
