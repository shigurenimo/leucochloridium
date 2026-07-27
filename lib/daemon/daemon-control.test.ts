import { describe, expect, it } from "vitest"
import type { LaunchAgentStatus } from "@/boot/leuco-launch-agent"
import {
  type DaemonStartOutcome,
  daemonSupervisionWarning,
  restartDaemon,
  startDaemon,
  stopDaemonAndVerify,
  waitForDaemonReady,
} from "@/daemon/daemon-control"
import { MemoryDaemonReadiness } from "@/daemon/memory-daemon-readiness"

const launchStatus = (overrides: Partial<LaunchAgentStatus> = {}): LaunchAgentStatus => ({
  label: "io.leuco.daemon",
  plistPath: "/tmp/io.leuco.daemon.plist",
  isInstalled: true,
  isLoaded: true,
  ...overrides,
})

const fakeDaemon = (calls: string[], initiallyRunning = false) => {
  const state: { isRunning: boolean; pid: number | null } = {
    isRunning: initiallyRunning,
    pid: initiallyRunning ? 101 : null,
  }

  return {
    getLogPath: () => "/tmp/leuco.log",
    status: () => ({
      pid: state.pid,
      isRunning: state.isRunning,
      identityVerified: state.isRunning,
      pidPath: "/tmp/leuco.pid",
      logPath: "/tmp/leuco.log",
    }),
    start: () => {
      calls.push("daemon.start")
      state.isRunning = true
      state.pid = 202
      return { pid: 202, logPath: "/tmp/leuco.log" }
    },
    stop: () => {
      calls.push("daemon.stop")
      const stoppedPid = state.pid
      state.isRunning = false
      state.pid = null
      return { stopped: true, pid: stoppedPid }
    },
    setRunning: (pid: number | null) => {
      state.isRunning = pid !== null
      state.pid = pid
    },
  }
}

const fakeAgent = (
  calls: string[],
  status: LaunchAgentStatus | Error = launchStatus(),
  onKickstart: (() => void) | null = null,
) => ({
  status: async () => {
    calls.push("launchd.status")
    return status
  },
  kickstart: async () => {
    calls.push("launchd.kickstart")
    onKickstart?.()
  },
})

describe("daemon control", () => {
  it("uses launchd only after its gateway is healthy", async () => {
    const calls: string[] = []
    const daemon = fakeDaemon(calls)
    const readiness = new MemoryDaemonReadiness({ replies: [303] })

    const result = await startDaemon({
      daemon,
      launchAgent: fakeAgent(calls, launchStatus(), () => daemon.setRunning(303)),
      platform: "darwin",
      binPath: "/bin/leuco",
      env: {},
      readiness,
    })

    expect(result).toEqual({
      mode: "launchd",
      label: "io.leuco.daemon",
      logPath: "/tmp/leuco.log",
    })
    expect(calls).toEqual(["launchd.status", "launchd.kickstart"])
    expect(readiness.probes).toEqual([{ port: 7331, timeoutMs: 1_000 }])
  })

  it("waits for launchd to publish its pid lease", async () => {
    const calls: string[] = []
    const daemon = fakeDaemon(calls)
    const readiness = new MemoryDaemonReadiness({
      replies: [303],
      onSleep: () => daemon.setRunning(303),
    })

    const result = await startDaemon({
      daemon,
      launchAgent: fakeAgent(calls),
      platform: "darwin",
      binPath: "/bin/leuco",
      env: {},
      readiness,
    })

    expect(result).toMatchObject({ mode: "launchd" })
    expect(readiness.sleeps).toEqual([100])
  })

  it("falls back to detached start and waits for its gateway", async () => {
    const calls: string[] = []
    const readiness = new MemoryDaemonReadiness({ replies: [202] })

    const result = await startDaemon({
      daemon: fakeDaemon(calls),
      launchAgent: fakeAgent(calls, launchStatus({ isLoaded: false })),
      platform: "darwin",
      binPath: "/bin/leuco",
      env: {},
      readiness,
    })

    expect(result).toEqual({ mode: "detached", pid: 202, logPath: "/tmp/leuco.log" })
    expect(calls).toEqual(["launchd.status", "daemon.start"])
  })

  it("reports a detached daemon that exits before gateway readiness", async () => {
    const calls: string[] = []
    const daemon = fakeDaemon(calls)
    const originalStart = daemon.start
    daemon.start = () => {
      const started = originalStart()
      daemon.setRunning(null)
      return started
    }

    const result = await startDaemon({
      daemon,
      platform: "linux",
      binPath: "/bin/leuco",
      env: {},
      readiness: new MemoryDaemonReadiness(),
    })

    expect(result).toEqual(
      new Error(
        "daemon pid 202 exited or was replaced before gateway became ready; log: /tmp/leuco.log",
      ),
    )
    expect(calls).toEqual(["daemon.start", "daemon.stop"])
  })

  it("times out with the health URL and log path, then drains a detached daemon", async () => {
    const calls: string[] = []
    const readiness = new MemoryDaemonReadiness()

    const result = await startDaemon({
      daemon: fakeDaemon(calls),
      platform: "linux",
      binPath: "/bin/leuco",
      env: { LEUCO_PORT: "9743" },
      readiness,
      readinessTimeoutMs: 30,
      readinessPollIntervalMs: 10,
    })

    expect(result).toEqual(
      new Error(
        "daemon gateway did not become ready at http://127.0.0.1:9743/health within 30ms; log: /tmp/leuco.log",
      ),
    )
    expect(readiness.probes.every((probe) => probe.port === 9743)).toBe(true)
    expect(calls).toEqual(["daemon.start", "daemon.stop"])
  })

  it("does not accept a healthy response from another pid", async () => {
    const calls: string[] = []
    const readiness = new MemoryDaemonReadiness({ replies: [999, 202] })

    const result = await startDaemon({
      daemon: fakeDaemon(calls),
      platform: "linux",
      binPath: "/bin/leuco",
      env: {},
      readiness,
      readinessTimeoutMs: 20,
      readinessPollIntervalMs: 10,
    })

    expect(result).toMatchObject({ mode: "detached", pid: 202 })
    expect(readiness.sleeps).toEqual([10])
  })

  it("retries a probe failure within the bounded readiness window", async () => {
    const calls: string[] = []
    const readiness = new MemoryDaemonReadiness({
      replies: [new Error("connection reset"), 202],
    })

    const result = await startDaemon({
      daemon: fakeDaemon(calls),
      platform: "linux",
      binPath: "/bin/leuco",
      env: {},
      readiness,
      readinessTimeoutMs: 20,
      readinessPollIntervalMs: 10,
    })

    expect(result).toMatchObject({ mode: "detached", pid: 202 })
  })

  it("gracefully stops before kickstarting and verifying a managed restart", async () => {
    const calls: string[] = []
    const daemon = fakeDaemon(calls, true)

    const result = await restartDaemon({
      daemon,
      launchAgent: fakeAgent(calls, launchStatus(), () => daemon.setRunning(303)),
      platform: "darwin",
      binPath: "/bin/leuco",
      env: {},
      readiness: new MemoryDaemonReadiness({ replies: [303] }),
    })

    expect(result).toMatchObject({ mode: "launchd", label: "io.leuco.daemon" })
    expect(calls).toEqual(["launchd.status", "daemon.stop", "launchd.kickstart"])
  })

  it("fails when a managed pid is replaced before becoming healthy", async () => {
    const calls: string[] = []
    const daemon = fakeDaemon(calls)
    const readiness = new MemoryDaemonReadiness({
      replies: [null],
      onSleep: () => daemon.setRunning(404),
    })

    const result = await startDaemon({
      daemon,
      launchAgent: fakeAgent(calls, launchStatus(), () => daemon.setRunning(303)),
      platform: "darwin",
      binPath: "/bin/leuco",
      env: {},
      readiness,
      readinessTimeoutMs: 20,
      readinessPollIntervalMs: 10,
    })

    expect(result).toEqual(
      new Error(
        "daemon pid 303 exited or was replaced before gateway became ready; log: /tmp/leuco.log",
      ),
    )
  })

  it("does not fall back to a detached daemon when launchd status fails", async () => {
    const calls: string[] = []

    const result = await startDaemon({
      daemon: fakeDaemon(calls),
      launchAgent: fakeAgent(calls, new Error("launchctl unavailable")),
      platform: "darwin",
      binPath: "/bin/leuco",
      env: {},
      readiness: new MemoryDaemonReadiness(),
    })

    expect(result).toEqual(new Error("launchctl unavailable"))
    expect(calls).toEqual(["launchd.status"])
  })

  it("refuses a destructive mutation when the daemon remains alive", () => {
    const calls: string[] = []
    const daemon = fakeDaemon(calls, true)
    daemon.stop = () => {
      calls.push("daemon.stop")
      return { stopped: false, pid: 101 }
    }

    const result = stopDaemonAndVerify(daemon)

    expect(result).toEqual(new Error("daemon pid 101 did not stop"))
    expect(calls).toEqual(["daemon.stop"])
  })

  it("does not accept an unverified legacy lease as ready", async () => {
    const daemon = fakeDaemon([])
    daemon.setRunning(123)
    const originalStatus = daemon.status
    daemon.status = () => ({ ...originalStatus(), identityVerified: false })

    const result = await waitForDaemonReady({
      daemon,
      env: {},
      expectedPid: null,
      readiness: new MemoryDaemonReadiness({ replies: [123, 123] }),
      readinessTimeoutMs: 10,
      readinessPollIntervalMs: 10,
    })

    expect(result).toEqual(
      new Error(
        "daemon gateway did not become ready at http://127.0.0.1:7331/health within 10ms; log: /tmp/leuco.log",
      ),
    )
  })

  it("warns when macOS falls back to an unsupervised detached daemon", () => {
    const detached: DaemonStartOutcome = {
      mode: "detached",
      pid: 202,
      logPath: "/tmp/leuco.log",
    }
    const managed: DaemonStartOutcome = {
      mode: "launchd",
      label: "io.leuco.daemon",
      logPath: "/tmp/leuco.log",
    }

    expect(daemonSupervisionWarning(detached, "darwin")).toContain("leuco boot install")
    expect(daemonSupervisionWarning(detached, "linux")).toBeNull()
    expect(daemonSupervisionWarning(managed, "darwin")).toBeNull()
  })
})
