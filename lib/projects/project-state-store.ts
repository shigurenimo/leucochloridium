import { existsSync, readFileSync } from "node:fs"
import { z } from "zod"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { LeucoPaths } from "@/paths/leuco-paths"

const projectStateSchema = z.object({
  codexThreadId: z.string().min(1).nullable().default(null),
  scheduleLastFiredAt: z.record(z.string(), z.number()).default({}),
})

export type ProjectState = z.infer<typeof projectStateSchema>

const EMPTY_STATE: ProjectState = { codexThreadId: null, scheduleLastFiredAt: {} }

type Props = {
  paths?: LeucoPaths
}

/**
 * Read / write the per-project runtime state file at
 * `~/.leuco/projects/<id>/state.json`. Separated from `settings.json` so the
 * user-editable config surface stays clean while the daemon updates
 * `codexThreadId` (and future per-project state) on its own cadence.
 */
export class LeucoProjectStateStore {
  private readonly paths: LeucoPaths

  constructor(props: Props = {}) {
    this.paths = props.paths ?? new LeucoPaths()
    Object.freeze(this)
  }

  load(projectId: string): ProjectState {
    const path = this.paths.projectStatePath(projectId)
    if (!existsSync(path)) return EMPTY_STATE

    const text = readFileSync(path, "utf8")
    const json = JSON.parse(text)
    return projectStateSchema.parse(json)
  }

  save(projectId: string, state: ProjectState): string {
    return atomicWriteJson({
      path: this.paths.projectStatePath(projectId),
      data: state,
    })
  }

  setCodexThreadId(projectId: string, codexThreadId: string | null): string {
    const current = this.load(projectId)
    return this.save(projectId, { ...current, codexThreadId })
  }

  markScheduleEntryFired(projectId: string, entryId: string, firedAt: number): string {
    const current = this.load(projectId)
    return this.save(projectId, {
      ...current,
      scheduleLastFiredAt: { ...current.scheduleLastFiredAt, [entryId]: firedAt },
    })
  }
}
