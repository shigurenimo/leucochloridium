import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoAgentStateStore } from "@/projects/agent-state-store"
import { LeucoProjectStore } from "@/projects/project-store"

const PROJECT_ID = "00000000-0000-4000-8000-000000000000"

describe("LeucoAgentStateStore", () => {
  let home = ""
  let paths: LeucoPaths
  let store: LeucoAgentStateStore

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leuco-agent-state-"))
    paths = new LeucoPaths({ home })
    store = new LeucoAgentStateStore({ paths })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("load returns the empty state when state.json is missing", () => {
    expect(store.load(PROJECT_ID, "reviewer")).toEqual({
      codexThreadId: null,
      scheduleLastFiredAt: {},
    })
  })

  it("setCodexThreadId writes state.json under agents/<a>/", () => {
    const written = store.setCodexThreadId(PROJECT_ID, "reviewer", "thr_123")
    expect(written).toBe(paths.agentStatePath(PROJECT_ID, "reviewer"))
    const text = readFileSync(written, "utf8")
    expect(text).toContain('"codexThreadId": "thr_123"')

    expect(store.load(PROJECT_ID, "reviewer")).toEqual({
      codexThreadId: "thr_123",
      scheduleLastFiredAt: {},
    })
  })

  it("setCodexThreadId(null) clears the field but keeps the file", () => {
    store.setCodexThreadId(PROJECT_ID, "reviewer", "thr_123")
    store.setCodexThreadId(PROJECT_ID, "reviewer", null)
    expect(store.load(PROJECT_ID, "reviewer")).toEqual({
      codexThreadId: null,
      scheduleLastFiredAt: {},
    })
  })

  it("markScheduleEntryFired records lastFiredAt per entry id", () => {
    store.markScheduleEntryFired(PROJECT_ID, "reviewer", "entry-a", 1000)
    store.markScheduleEntryFired(PROJECT_ID, "reviewer", "entry-b", 2000)
    expect(store.load(PROJECT_ID, "reviewer").scheduleLastFiredAt).toEqual({
      "entry-a": 1000,
      "entry-b": 2000,
    })
  })
})

describe("LeucoProjectStore migrates codexThreadId out of settings.json", () => {
  let home = ""

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leuco-state-migrate-"))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("moves legacy codexThreadId into agents/<a>/state.json", () => {
    const paths = new LeucoPaths({ home })
    const settingsPath = paths.projectSettingsPath(PROJECT_ID)
    mkdirSync(dirname(settingsPath), { recursive: true })
    const legacySettings = {
      id: PROJECT_ID,
      name: "demo",
      path: "/tmp/demo",
      agents: [
        {
          name: "reviewer",
          enabled: true,
          useCommonInstructions: true,
          prompts: ["friendly"],
          codexThreadId: "thr_legacy",
          channels: [],
        },
      ],
    }
    writeFileSync(settingsPath, JSON.stringify(legacySettings, null, 2))

    const projectStore = new LeucoProjectStore({ paths })
    const project = projectStore.load(PROJECT_ID)

    // Re-reading settings.json via list() must trigger the migration.
    projectStore.list()

    const cleaned = JSON.parse(readFileSync(settingsPath, "utf8"))
    expect(cleaned.agents[0].codexThreadId).toBeUndefined()

    const stateStore = new LeucoAgentStateStore({ paths })
    expect(stateStore.load(PROJECT_ID, "reviewer").codexThreadId).toBe("thr_legacy")

    expect(project.agents[0]?.name).toBe("reviewer")
  })
})
