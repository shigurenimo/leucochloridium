import { existsSync, readFileSync } from "node:fs"
import { z } from "zod"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { LeucoPaths } from "@/paths/leuco-paths"

const agentStateSchema = z.object({
  /**
   * Codex `thread/start` id the tenant uses across every channel and turn.
   * Set the first time the agent runs; reused via `thread/resume` afterward.
   * `null` while the agent has never run, or after `agents reset` clears it.
   */
  codexThreadId: z.string().min(1).nullable().default(null),
  /**
   * Per-schedule-entry `lastFiredAt` (epoch ms). Used by the schedule plugin
   * to fire a single catch-up after daemon downtime / system sleep — the
   * `lastFiredMinute` Map is in-memory only and forgets across restarts, so
   * a persistent timestamp is the only way to know whether a cron should
   * back-fill. Keyed by `ScheduleEntry.id`; missing entries are treated as
   * "never fired".
   */
  scheduleLastFiredAt: z.record(z.string(), z.number()).default({}),
})

export type AgentState = z.infer<typeof agentStateSchema>

const EMPTY_STATE: AgentState = { codexThreadId: null, scheduleLastFiredAt: {} }

type Props = {
  paths?: LeucoPaths
}

/**
 * Read / write the per-agent runtime state file at
 * `~/.leuco/projects/<id>/agents/<a>/state.json`. Separated from
 * `settings.json` so the user-editable config surface stays clean while the
 * daemon updates `codexThreadId` (and future per-agent state) on its own
 * cadence. Missing file is treated as the empty state — no need to
 * pre-create one when `agents add` runs.
 */
export class LeucoAgentStateStore {
  private readonly paths: LeucoPaths

  constructor(props: Props = {}) {
    this.paths = props.paths ?? new LeucoPaths()
    Object.freeze(this)
  }

  load(projectId: string, agentName: string): AgentState {
    const path = this.paths.agentStatePath(projectId, agentName)
    if (!existsSync(path)) return EMPTY_STATE

    const text = readFileSync(path, "utf8")
    const json = JSON.parse(text)
    return agentStateSchema.parse(json)
  }

  /**
   * Write state.json atomically. Called every turn (codexThreadId) and on
   * every schedule fire (lastFiredAt); a non-atomic writeFileSync risks a
   * truncated state file from a crash mid-write, which would lose the agent's
   * codex thread and cause every later message to start a fresh conversation.
   */
  save(projectId: string, agentName: string, state: AgentState): string {
    return atomicWriteJson({
      path: this.paths.agentStatePath(projectId, agentName),
      data: state,
    })
  }

  setCodexThreadId(projectId: string, agentName: string, codexThreadId: string | null): string {
    const current = this.load(projectId, agentName)
    return this.save(projectId, agentName, { ...current, codexThreadId })
  }

  markScheduleEntryFired(
    projectId: string,
    agentName: string,
    entryId: string,
    firedAt: number,
  ): string {
    const current = this.load(projectId, agentName)
    return this.save(projectId, agentName, {
      ...current,
      scheduleLastFiredAt: { ...current.scheduleLastFiredAt, [entryId]: firedAt },
    })
  }
}
