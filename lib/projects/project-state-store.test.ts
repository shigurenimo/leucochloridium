import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { LeucoPaths } from "@/paths/leuco-paths"
import { EMPTY_PROJECT_STATE } from "@/projects/project-state-schema"
import { LeucoProjectStateStore } from "@/projects/project-state-store"

const PROJECT_ID = "00000000-0000-4000-8000-000000000000"

describe("LeucoProjectStateStore", () => {
  let home = ""
  let paths: LeucoPaths
  let store: LeucoProjectStateStore

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leuco-project-state-"))
    paths = new LeucoPaths({ home })
    store = new LeucoProjectStateStore({ paths })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("clears thread ids without losing valid schedule state", () => {
    store.setCodexThreadId(PROJECT_ID, "shared-thread")
    store.setCodexThreadIds(PROJECT_ID, { slack: "slack-thread" })
    store.markScheduleEntryFired(PROJECT_ID, "daily", 123)

    expect(store.clearCodexThreads(PROJECT_ID)).toEqual({
      codexThreadId: null,
      codexThreadIds: {},
      scheduleLastFiredAt: { daily: 123 },
    })
  })

  it.each([
    ["invalid JSON", "{"],
    [
      "invalid schema",
      JSON.stringify({
        codexThreadId: 42,
        codexThreadIds: {},
        scheduleLastFiredAt: {},
      }),
    ],
  ])("replaces %s when explicitly clearing sessions", (_label, text) => {
    const path = paths.projectStatePath(PROJECT_ID)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)

    expect(store.clearCodexThreads(PROJECT_ID)).toEqual(EMPTY_PROJECT_STATE)
    expect(store.load(PROJECT_ID)).toEqual(EMPTY_PROJECT_STATE)
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(EMPTY_PROJECT_STATE)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
