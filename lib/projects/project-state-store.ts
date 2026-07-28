import { existsSync, readFileSync } from "node:fs"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { withFileLock } from "@/fs/with-file-lock"
import { LeucoPaths } from "@/paths/leuco-paths"
import {
  EMPTY_PROJECT_STATE,
  type ProjectState,
  projectStateSchema,
} from "@/projects/project-state-schema"

export type { ProjectState }

type Props = {
  paths?: LeucoPaths
}

export class LeucoProjectStateStore {
  private readonly paths: LeucoPaths

  constructor(props: Props = {}) {
    this.paths = props.paths ?? new LeucoPaths()
    Object.freeze(this)
  }

  load(projectId: string): ProjectState {
    const path = this.paths.projectStatePath(projectId)
    if (!existsSync(path)) return copyState(EMPTY_PROJECT_STATE)

    const json: unknown = JSON.parse(readFileSync(path, "utf8"))
    return projectStateSchema.parse(json)
  }

  setCodexThreadId(projectId: string, codexThreadId: string | null): void {
    this.update(projectId, (state) => ({ ...state, codexThreadId }))
  }

  setCodexThreadIds(projectId: string, codexThreadIds: Readonly<Record<string, string>>): void {
    this.update(projectId, (state) => ({
      ...state,
      codexThreadIds: { ...codexThreadIds },
    }))
  }

  clearCodexThreads(projectId: string): ProjectState {
    return this.update(projectId, (state) => ({
      ...state,
      codexThreadId: null,
      codexThreadIds: {},
    }))
  }

  markScheduleEntryFired(projectId: string, entryId: string, firedAt: number): void {
    this.update(projectId, (state) => ({
      ...state,
      scheduleLastFiredAt: { ...state.scheduleLastFiredAt, [entryId]: firedAt },
    }))
  }

  removeScheduleEntry(projectId: string, entryId: string): void {
    this.update(projectId, (state) => {
      const scheduleLastFiredAt = { ...state.scheduleLastFiredAt }
      delete scheduleLastFiredAt[entryId]

      return { ...state, scheduleLastFiredAt }
    })
  }

  private update(
    projectId: string,
    transform: (state: ProjectState) => ProjectState,
  ): ProjectState {
    const path = this.paths.projectStatePath(projectId)

    return withFileLock({ lockPath: `${path}.lock` }, () => {
      const updated = projectStateSchema.parse(transform(this.load(projectId)))
      atomicWriteJson({ path, data: updated, mode: 0o600 })
      return updated
    })
  }
}

function copyState(state: ProjectState): ProjectState {
  return {
    codexThreadId: state.codexThreadId,
    codexThreadIds: { ...state.codexThreadIds },
    scheduleLastFiredAt: { ...state.scheduleLastFiredAt },
  }
}
