import { describe, expect, it, vi } from "vitest"
import { readDiagnosticConfiguration } from "@/cli/read-diagnostic-configuration"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryMaintenanceStore } from "@/maintenance/memory-maintenance-store"

describe("independent configuration diagnosis", () => {
  it("collects independent read failures with their causes without rewriting state", () => {
    const store = new MemoryLeucoStore()
    const maintenance = new MemoryMaintenanceStore()
    const updateSettings = vi.spyOn(store, "updateSettings")
    const updateState = vi.spyOn(store, "updateState")
    vi.spyOn(store, "loadSettings").mockImplementation(() => {
      throw new Error("settings damaged")
    })
    vi.spyOn(store, "loadState").mockImplementation(() => {
      throw new Error("state damaged")
    })
    vi.spyOn(maintenance, "readLaunch").mockImplementation(() => {
      throw new Error("launch damaged")
    })
    const report = readDiagnosticConfiguration(store, maintenance)
    expect(report).toMatchObject({ valid: false, stateValid: false, launch: null })
    expect(report.failures.map((failure) => failure.phase)).toEqual(["settings", "state", "launch"])
    expect(report.failures.map((failure) => failure.causes[0]?.message)).toEqual([
      "settings damaged",
      "state damaged",
      "launch damaged",
    ])
    expect(updateSettings).not.toHaveBeenCalled()
    expect(updateState).not.toHaveBeenCalled()
  })
  it("keeps settings and invocation overrides distinct and returns owned snapshots", () => {
    const store = new MemoryLeucoStore({ soul: "/saved/SOUL.md" })
    const maintenance = new MemoryMaintenanceStore()
    maintenance.writeLaunch({ workingDirectory: "/work", codexHome: null, soul: null })
    const report = readDiagnosticConfiguration(store, maintenance)
    expect(report.errors).toEqual([])
    expect(report).toMatchObject({
      valid: true,
      stateValid: true,
      settings: { soul: "/saved/SOUL.md" },
      launch: { soul: null },
    })
    report.settings.soul = null
    expect(store.loadSettings().soul).toBe("/saved/SOUL.md")
  })
})
