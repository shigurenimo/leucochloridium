import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import { runDaemon } from "@/daemon/run-daemon"
import { appendDaemonLog } from "@/daemon/append-daemon-log"

type Fixture = {
  start: Mock<() => Promise<void>>
  stop: Mock<() => Promise<void>>
  release: Mock<() => boolean>
  runDiscordCommand: Mock<(...values: ReadonlyArray<unknown>) => Promise<unknown>>
  requestStop: ((requestId?: string) => void) | null
  routeDiscordCommand: DiscordRoute | null
}
type DiscordRoute = (parsed: unknown, requestId: string, signal: AbortSignal) => Promise<unknown>
const fixture = vi.hoisted((): Fixture => ({
  start: vi.fn(),
  stop: vi.fn(),
  release: vi.fn(),
  runDiscordCommand: vi.fn(),
  requestStop: null,
  routeDiscordCommand: null,
}))
vi.mock("node:fs", () => ({
  statSync: () => ({ isDirectory: () => true }),
  chmodSync: () => {},
}))
vi.mock("@/daemon/append-daemon-log", () => ({ appendDaemonLog: vi.fn() }))
vi.mock("@/storage/node-leuco-store", async () => {
  const memory = await import("@/storage/memory-leuco-store")
  return {
    NodeLeucoStore: class extends memory.MemoryLeucoStore {
      constructor() {
        super()
      }
      ensureHome() {}
    },
  }
})
vi.mock("@/maintenance/node-maintenance-store", async () => {
  const memory = await import("@/maintenance/memory-maintenance-store")
  return {
    NodeMaintenanceStore: class extends memory.MemoryMaintenanceStore {
      constructor() {
        super()
      }
    },
  }
})
vi.mock("@/maintenance/read-maintenance", () => ({ readMaintenance: () => null }))
vi.mock("@/maintenance/schedule-restart", () => ({ scheduleRestart: vi.fn() }))
vi.mock("@/daemon/daemon-lease", () => ({
  acquireDaemonLease: () => ({ pid: 4242, token: "lease-token" }),
  releaseDaemonLease: fixture.release,
}))
vi.mock("@/daemon/restrict-event-log-files", () => ({ restrictEventLogFiles: () => {} }))
vi.mock("@/events/leuco-event-log", () => ({
  LeucoEventLog: class {
    log() {}
    error() {}
    append() {}
    addRedactionSecrets() {}
    redactText(text: string) {
      return text
    }
    close() {}
  },
}))
vi.mock("@/runtime/runtime", () => ({
  LeucoRuntime: {
    build: () => ({
      start: fixture.start,
      stop: fixture.stop,
      runDiscordCommand: fixture.runDiscordCommand,
    }),
  },
}))
vi.mock("@/daemon/handle-daemon-request", () => ({
  handleDaemonRequest: (props: {
    stop: (requestId?: string) => void
    runDiscordCommand: DiscordRoute
  }) => {
    fixture.requestStop = props.stop
    fixture.routeDiscordCommand = props.runDiscordCommand
    return async () => new Response()
  },
}))
const lines = () => vi.mocked(appendDaemonLog).mock.calls.map((call) => call[1])
beforeEach(() => {
  vi.mocked(appendDaemonLog).mockReset()
  fixture.start.mockReset().mockResolvedValue()
  fixture.stop.mockReset().mockResolvedValue()
  fixture.release.mockReset().mockReturnValue(true)
  fixture.runDiscordCommand.mockReset().mockResolvedValue({ ok: true })
  fixture.requestStop = null
  fixture.routeDiscordCommand = null
  vi.stubGlobal("Bun", { serve: () => ({ stop: async () => {}, pendingRequests: 0 }) })
})
afterEach(() => vi.unstubAllGlobals())

it("records an execution failure with its level and the daemon requestId first", async () => {
  fixture.start.mockRejectedValue(new Error("codex unavailable"))
  await expect(runDaemon({ home: "/memory", requestId: "daemon-run" })).rejects.toThrow(
    "codex unavailable",
  )
  expect(lines()).toContain(
    "[error] requestId=daemon-run Daemon execution failed: codex unavailable",
  )
})

it("records an asynchronous fatal failure with its level and the daemon requestId first", async () => {
  const before = process.listeners("uncaughtException")
  const running = runDaemon({ home: "/memory", requestId: "daemon-run" })
  const added = process
    .listeners("uncaughtException")
    .filter((listener) => !before.includes(listener))
  expect(added).toHaveLength(1)
  await vi.waitFor(() => expect(lines()).toContain("[info] ready"))
  added[0]!(new Error("async boom"), "uncaughtException")
  await expect(running).rejects.toThrow("Daemon fatal asynchronous failure: async boom")
  expect(lines()).toContain("[error] requestId=daemon-run Fatal asynchronous failure: async boom")
  expect(lines()).toContain("[info] Daemon shutdown requested: fatal asynchronous failure")
  expect(process.listeners("uncaughtException")).toEqual(before)
})

it.each([
  ["control request", "control-stop"],
  ["abort", "daemon-run"],
])(
  "records a retained lease after %s with its level and the shutdown requestId first",
  async (reason, requestId) => {
    fixture.stop.mockRejectedValue(new Error("codex did not exit"))
    const controller = new AbortController()
    const running = runDaemon({
      home: "/memory",
      requestId: "daemon-run",
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(lines()).toContain("[info] ready"))
    if (reason === "abort") controller.abort()
    else fixture.requestStop?.("control-stop")
    await expect(running).rejects.toThrow("codex did not exit")
    expect(lines()).toContain(
      `[info]${reason === "abort" ? "" : " requestId=control-stop"} Daemon shutdown requested: ${reason}`,
    )
    expect(lines()).toContain(
      `[error] requestId=${requestId} Shutdown incomplete; lease retained until the process exits. Do not start a duplicate.`,
    )
    expect(fixture.release).not.toHaveBeenCalled()
  },
)

it("passes the control request signal to Discord commands", async () => {
  const running = runDaemon({ home: "/memory", requestId: "daemon-run" })
  await vi.waitFor(() => expect(lines()).toContain("[info] ready"))
  const controller = new AbortController()
  const parsed = { words: ["discord", "call"] }
  await expect(
    fixture.routeDiscordCommand?.(parsed, "discord-request", controller.signal),
  ).resolves.toEqual({ ok: true })
  expect(fixture.runDiscordCommand).toHaveBeenCalledWith(
    parsed,
    "discord-request",
    controller.signal,
  )
  fixture.requestStop?.("control-stop")
  await expect(running).resolves.toBeUndefined()
})
