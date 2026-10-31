import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { runCli } from "@/cli/run-cli"

const fixture = vi.hoisted(() => ({
  store: vi.fn(),
  start: vi.fn(),
  output: vi.fn(),
  text: vi.fn(),
  compatible: vi.fn(),
}))
vi.mock("@/storage/node-leuco-store", async () => {
  const memory = await import("@/storage/memory-leuco-store")
  return {
    NodeLeucoStore: class extends memory.MemoryLeucoStore {
      constructor() {
        super()
        fixture.store()
      }
      ensureHome() {}
    },
  }
})
vi.mock("@/daemon/start-daemon", () => ({ startDaemon: fixture.start }))
vi.mock("@/cli/write-cli-output", () => ({ writeCliOutput: fixture.output }))
vi.mock("@/cli/write-cli-text", () => ({ writeCliText: fixture.text }))
beforeEach(() => {
  fixture.store.mockReset()
  fixture.start.mockReset().mockResolvedValue({ running: true })
  fixture.output.mockReset()
  fixture.text.mockReset()
  fixture.compatible.mockReset().mockReturnValue(false)
  vi.stubGlobal("Bun", { version: "1.4.3", semver: { satisfies: fixture.compatible } })
})
afterEach(() => vi.unstubAllGlobals())

it.each([
  ["config", "set", "model", '"test-model"', "--json"],
  ["start", "--json"],
])("rejects an unsupported Bun before reading settings or starting work: %j", async (...args) => {
  await expect(runCli(args)).rejects.toMatchObject({
    code: "CHECK_FAILED",
    details: {
      phase: "runtime-version",
      executionStarted: false,
      current: "1.4.3",
      required: ">=1.4.4",
    },
  })
  expect(fixture.store).not.toHaveBeenCalled()
  expect(fixture.start).not.toHaveBeenCalled()
  expect(fixture.output).not.toHaveBeenCalled()
})

it.each([["--help"], ["--version", "--json"]])(
  "keeps diagnostic help and version available on an unsupported Bun: %j",
  async (...args) => {
    await expect(runCli(args)).resolves.toBeUndefined()
    expect(fixture.compatible).not.toHaveBeenCalled()
    expect(fixture.store).not.toHaveBeenCalled()
    expect(fixture.start).not.toHaveBeenCalled()
  },
)
