import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_TURN_CONCURRENCY,
  DEFAULT_TURN_IDLE_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
} from "@/engine/turn-timeouts"
import { globalSettingsSchema } from "@/global-settings/global-settings-schema"
import { LeucoGlobalSettingsStore } from "@/global-settings/global-settings-store"
import { LeucoPaths } from "@/paths/leuco-paths"

describe("globalSettingsSchema turn limits", () => {
  it("supplies stable recovery defaults for existing settings files", () => {
    const parsed = globalSettingsSchema.parse({ keepAwake: true, projects: [] })

    expect(parsed.turnTimeoutMs).toBe(DEFAULT_TURN_TIMEOUT_MS)
    expect(parsed.turnIdleTimeoutMs).toBe(DEFAULT_TURN_IDLE_TIMEOUT_MS)
    expect(parsed.turnConcurrency).toBe(DEFAULT_TURN_CONCURRENCY)
  })

  it("allows the hard deadline to be shorter than the idle deadline", () => {
    const parsed = globalSettingsSchema.parse({
      keepAwake: true,
      turnTimeoutMs: 10_000,
      turnIdleTimeoutMs: 11_000,
      projects: [],
    })

    expect(parsed.turnTimeoutMs).toBe(10_000)
    expect(parsed.turnIdleTimeoutMs).toBe(11_000)
  })
})

describe("LeucoGlobalSettingsStore turn limits", () => {
  let home = ""
  let store: LeucoGlobalSettingsStore

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leuco-global-settings-"))
    store = new LeucoGlobalSettingsStore({ paths: new LeucoPaths({ home }) })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("coerces and persists timeout values from the CLI representation", () => {
    const updated = store.set("turnIdleTimeoutMs", "90000")

    expect(updated).not.toBeInstanceOf(Error)
    if (updated instanceof Error) return
    expect(updated.turnIdleTimeoutMs).toBe(90_000)
    expect(store.load()).toEqual(updated)
  })

  it("persists a hard timeout shorter than the idle timeout", () => {
    const result = store.set("turnTimeoutMs", "60000")

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.turnTimeoutMs).toBe(60_000)
    expect(result.turnIdleTimeoutMs).toBe(DEFAULT_TURN_IDLE_TIMEOUT_MS)
    expect(store.load()).toEqual(result)
  })
})
