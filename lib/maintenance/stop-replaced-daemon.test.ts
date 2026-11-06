import { expect, it, vi } from "vitest"
import { CliError } from "@/cli/cli-error"
import { getDaemonLeaseId } from "@/daemon/get-daemon-lease-id"
import { errorDetails } from "@/error-details"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import {
  RESTART_OLD_DAEMON_EXIT_TIMEOUT_MS,
  RESTART_STOP_REQUEST_TIMEOUT_MS,
} from "@/maintenance/restart-worker-limits"
import { stopReplacedDaemon } from "@/maintenance/stop-replaced-daemon"

const lease = { pid: 42, token: "old-control-token" }
const operation = { oldPid: 42, oldLeaseId: getDaemonLeaseId(lease) }
const slowStop = new CliError("STATE_UNCERTAIN", "Cannot observe daemon response", {
  phase: "transport",
})

function fixture(props: { alive: ReadonlyArray<number>; stop?: unknown; exit?: unknown }) {
  const stop = props.stop
  const exit = props.exit
  return {
    isAlive: (pid: number) => props.alive.includes(pid),
    requestStop: vi.fn(async (): Promise<unknown> => {
      if (stop !== undefined) throw stop
      return { stopped: true }
    }),
    waitForExit: vi.fn(async (): Promise<void> => {
      if (exit !== undefined) throw exit
    }),
    onStopping: vi.fn(),
  }
}

it("waits for the old daemon's exit after a slow or unreachable /stop", async () => {
  const deps = fixture({ alive: [42], stop: slowStop })
  await expect(stopReplacedDaemon({ ...deps, operation, lease })).resolves.toBeUndefined()
  expect(deps.requestStop).toHaveBeenCalledWith(lease, RESTART_STOP_REQUEST_TIMEOUT_MS)
  expect(deps.waitForExit).toHaveBeenCalledWith(42, RESTART_OLD_DAEMON_EXIT_TIMEOUT_MS)
  expect(deps.onStopping).toHaveBeenCalledOnce()
})
it.each([
  ["released its lease", null],
  ["left a stale lease", { pid: 43, token: "stale-token" }],
])("waits for a recorded old daemon that %s but is still running", async (_label, current) => {
  const deps = fixture({ alive: [42] })
  await expect(stopReplacedDaemon({ ...deps, operation, lease: current })).resolves.toBeUndefined()
  expect(deps.requestStop).not.toHaveBeenCalled()
  expect(deps.waitForExit).toHaveBeenCalledWith(42, RESTART_OLD_DAEMON_EXIT_TIMEOUT_MS)
  expect(deps.onStopping).toHaveBeenCalledOnce()
})
it("ends uncertain with both causes when the exit is not observed", async () => {
  const deps = fixture({
    alive: [42],
    stop: slowStop,
    exit: Object.assign(new Error("Process exit was not observed"), { code: "ETIMEDOUT" }),
  })
  const failure = await stopReplacedDaemon({ ...deps, operation, lease }).then(
    () => null,
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    message: "Old daemon is still stopping. No replacement was started.",
    details: { phase: "process-exit", pid: 42, stopRequestFailed: true },
  })
  const messages = errorDetails(failure).map((cause) => cause.message)
  expect(messages).toEqual(
    expect.arrayContaining(["Process exit was not observed", "Cannot observe daemon response"]),
  )
})
it("refuses to stop a different live owner", async () => {
  const deps = fixture({ alive: [42, 43] })
  await expect(
    stopReplacedDaemon({ ...deps, operation, lease: { pid: 43, token: "other-token" } }),
  ).rejects.toThrow("identity changed")
  expect(deps.requestStop).not.toHaveBeenCalled()
  expect(deps.waitForExit).not.toHaveBeenCalled()
})
it("does not wait when the lease changed owner before the stop request", async () => {
  const conflict = new CliError("STATE_CONFLICT", "Daemon identity changed before the request")
  const deps = fixture({ alive: [42], stop: conflict })
  await expect(stopReplacedDaemon({ ...deps, operation, lease })).rejects.toBe(conflict)
  expect(deps.waitForExit).not.toHaveBeenCalled()
})
it("waits for an old daemon that recorded its exit when releasing ownership but still runs", async () => {
  const deps = fixture({ alive: [42] })
  const released: Pick<MaintenanceOperation, "oldPid" | "oldLeaseId" | "oldPidExited"> = {
    ...operation,
    oldPidExited: true,
  }
  await expect(
    stopReplacedDaemon({ ...deps, operation: released, lease: null }),
  ).resolves.toBeUndefined()
  expect(deps.waitForExit).toHaveBeenCalledWith(42, RESTART_OLD_DAEMON_EXIT_TIMEOUT_MS)
  expect(deps.onStopping).toHaveBeenCalledOnce()
})
it.each<[string, Pick<MaintenanceOperation, "oldPid" | "oldLeaseId">, number[]]>([
  ["exited", operation, []],
  ["was never recorded", { oldPid: null, oldLeaseId: null }, [42]],
])("does nothing when the old daemon %s", async (_label, recorded, alive) => {
  const deps = fixture({ alive })
  await expect(
    stopReplacedDaemon({ ...deps, operation: recorded, lease: null }),
  ).resolves.toBeUndefined()
  expect(deps.onStopping).not.toHaveBeenCalled()
  expect(deps.waitForExit).not.toHaveBeenCalled()
})
