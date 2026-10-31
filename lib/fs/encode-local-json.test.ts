import { expect, it } from "vitest"
import { encodeLocalJson } from "@/fs/encode-local-json"
import { DEFAULT_LOCAL_DATA_MAX_BYTES } from "@/fs/local-data-limits"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryMaintenanceStore } from "@/maintenance/memory-maintenance-store"

it("preserves pretty JSON and its trailing newline", () => {
  expect(encodeLocalJson({ ok: true })).toBe('{\n  "ok": true\n}\n')
})
it("counts the trailing newline at the exact read boundary", () => {
  const exact = "a".repeat(DEFAULT_LOCAL_DATA_MAX_BYTES - 3)
  expect(Buffer.byteLength(encodeLocalJson(exact), "utf8")).toBe(DEFAULT_LOCAL_DATA_MAX_BYTES)
  expect(() => encodeLocalJson(`${exact}a`)).toThrow(/byte write limit/)
})
it("measures encoded UTF-8 bytes rather than string length", () => {
  const value = "あ".repeat(Math.ceil(DEFAULT_LOCAL_DATA_MAX_BYTES / 3))
  expect(value.length).toBeLessThan(DEFAULT_LOCAL_DATA_MAX_BYTES)
  expect(() => encodeLocalJson(value)).toThrow(/byte write limit/)
})
it("preserves Memory settings and state when an oversized update is rejected", () => {
  const store = new MemoryLeucoStore({ model: "preserved-model" })
  const settings = store.loadSettings()
  const state = store.loadState()
  const oversized = "あ".repeat(Math.ceil(DEFAULT_LOCAL_DATA_MAX_BYTES / 3))
  expect(() => store.updateSettings((current) => ({ ...current, model: oversized }))).toThrow(
    /byte write limit/,
  )
  expect(() =>
    store.updateState((current) => ({
      ...current,
      threads: { large: { id: "large-thread", context: oversized } },
    })),
  ).toThrow(/byte write limit/)
  expect(store.loadSettings()).toEqual(settings)
  expect(store.loadState()).toEqual(state)
})
it("preserves a Memory launch document after an oversized update", () => {
  const store = new MemoryMaintenanceStore()
  const launch = { workingDirectory: "/memory", codexHome: null }
  store.writeLaunch(launch)
  expect(() =>
    store.writeLaunch({
      ...launch,
      workingDirectory: `/${"あ".repeat(Math.ceil(DEFAULT_LOCAL_DATA_MAX_BYTES / 3))}`,
    }),
  ).toThrow(/byte write limit/)
  expect(store.readLaunch()).toEqual(launch)
})
