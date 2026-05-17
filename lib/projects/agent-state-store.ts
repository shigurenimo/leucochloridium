import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { LeucoPaths } from "@/paths/leuco-paths"

const agentStateSchema = z.object({
  /**
   * Codex `thread/start` id the tenant uses across every channel and turn.
   * Set the first time the agent runs; reused via `thread/resume` afterward.
   * `null` while the agent has never run, or after `agents reset` clears it.
   */
  codexThreadId: z.string().min(1).nullable().default(null),
})

export type AgentState = z.infer<typeof agentStateSchema>

const EMPTY_STATE: AgentState = { codexThreadId: null }

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

  save(projectId: string, agentName: string, state: AgentState): string {
    const path = this.paths.agentStatePath(projectId, agentName)
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
    return path
  }

  setCodexThreadId(projectId: string, agentName: string, codexThreadId: string | null): string {
    const current = this.load(projectId, agentName)
    return this.save(projectId, agentName, { ...current, codexThreadId })
  }
}
