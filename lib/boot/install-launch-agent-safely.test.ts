import { describe, expect, it } from "vitest"
import { installLaunchAgentSafely } from "@/boot/install-launch-agent-safely"

const status = (isRunning: boolean) => ({
  pid: isRunning ? 101 : null,
  isRunning,
  pidPath: "/tmp/leuco.pid",
  logPath: "/tmp/leuco.log",
})

describe("installLaunchAgentSafely", () => {
  it("drains a running daemon before installing the managed replacement", async () => {
    const calls: string[] = []
    let isRunning = true

    const installed = await installLaunchAgentSafely({
      daemon: {
        status: () => {
          calls.push("status")
          return status(isRunning)
        },
        stop: () => {
          calls.push("stop")
          isRunning = false
          return { stopped: true, pid: 101 }
        },
      },
      install: async () => {
        calls.push("install")
        return {
          plistPath: "/tmp/io.leuco.daemon.plist",
          label: "io.leuco.daemon",
        }
      },
      restore: async () => {
        calls.push("restore")
        return { mode: "detached", pid: 202, logPath: "/tmp/leuco.log" }
      },
    })

    expect(installed).toEqual({
      plistPath: "/tmp/io.leuco.daemon.plist",
      label: "io.leuco.daemon",
    })
    expect(calls).toEqual(["status", "status", "stop", "status", "install"])
  })

  it("restores the previous daemon when installation fails after shutdown", async () => {
    const calls: string[] = []
    let isRunning = true

    const installed = await installLaunchAgentSafely({
      daemon: {
        status: () => {
          calls.push("status")
          return status(isRunning)
        },
        stop: () => {
          calls.push("stop")
          isRunning = false
          return { stopped: true, pid: 101 }
        },
      },
      install: async () => {
        calls.push("install")
        return new Error("bootstrap denied")
      },
      restore: async () => {
        calls.push("restore")
        return { mode: "detached", pid: 202, logPath: "/tmp/leuco.log" }
      },
    })

    expect(installed).toEqual(
      new Error(
        "LaunchAgent install failed: bootstrap denied (previous daemon restored via detached pid 202)",
      ),
    )
    expect(calls).toEqual(["status", "status", "stop", "status", "install", "restore"])
  })

  it("reports both failures when installation and restoration fail", async () => {
    let isRunning = true

    const installed = await installLaunchAgentSafely({
      daemon: {
        status: () => status(isRunning),
        stop: () => {
          isRunning = false
          return { stopped: true, pid: 101 }
        },
      },
      install: async () => new Error("invalid plist"),
      restore: async () => new Error("spawn denied"),
    })

    expect(installed).toEqual(
      new Error(
        "LaunchAgent install failed (invalid plist); previous daemon also failed to restart: spawn denied",
      ),
    )
  })

  it("does not install when the existing daemon cannot be stopped", async () => {
    const calls: string[] = []

    const installed = await installLaunchAgentSafely({
      daemon: {
        status: () => status(true),
        stop: () => {
          calls.push("stop")
          return { stopped: false, pid: 101 }
        },
      },
      install: async () => {
        calls.push("install")
        return {
          plistPath: "/tmp/io.leuco.daemon.plist",
          label: "io.leuco.daemon",
        }
      },
      restore: async () => {
        calls.push("restore")
        return { mode: "detached", pid: 202, logPath: "/tmp/leuco.log" }
      },
    })

    expect(installed).toEqual(
      new Error(
        "cannot install LaunchAgent while daemon is still running: daemon pid 101 did not stop",
      ),
    )
    expect(calls).toEqual(["stop"])
  })

  it("verifies a successfully bootstrapped LaunchAgent before reporting success", async () => {
    const calls: string[] = []

    const installed = await installLaunchAgentSafely({
      daemon: {
        status: () => status(false),
        stop: () => ({ stopped: false, pid: null }),
      },
      install: async () => {
        calls.push("install")
        return {
          plistPath: "/tmp/io.leuco.daemon.plist",
          label: "io.leuco.daemon",
        }
      },
      verify: async () => {
        calls.push("verify")
      },
      rollback: async () => {
        calls.push("rollback")
      },
      restore: async () => {
        calls.push("restore")
        return { mode: "detached", pid: 202, logPath: "/tmp/leuco.log" }
      },
    })

    expect(installed).toEqual({
      plistPath: "/tmp/io.leuco.daemon.plist",
      label: "io.leuco.daemon",
    })
    expect(calls).toEqual(["install", "verify"])
  })

  it("rolls back an unhealthy LaunchAgent before restoring the previous daemon", async () => {
    const calls: string[] = []
    let isRunning = true

    const installed = await installLaunchAgentSafely({
      daemon: {
        status: () => status(isRunning),
        stop: () => {
          isRunning = false
          return { stopped: true, pid: 101 }
        },
      },
      install: async () => {
        calls.push("install")
        return {
          plistPath: "/tmp/io.leuco.daemon.plist",
          label: "io.leuco.daemon",
        }
      },
      verify: async () => {
        calls.push("verify")
        return new Error("gateway timeout; log: /tmp/leuco.log")
      },
      rollback: async () => {
        calls.push("rollback")
      },
      restore: async () => {
        calls.push("restore")
        return { mode: "detached", pid: 202, logPath: "/tmp/leuco.log" }
      },
    })

    expect(installed).toEqual(
      new Error(
        "LaunchAgent gateway readiness failed: gateway timeout; log: /tmp/leuco.log (previous daemon restored via detached pid 202)",
      ),
    )
    expect(calls).toEqual(["install", "verify", "rollback", "restore"])
  })

  it("does not restore a detached daemon when LaunchAgent rollback fails", async () => {
    const calls: string[] = []
    let isRunning = true

    const installed = await installLaunchAgentSafely({
      daemon: {
        status: () => status(isRunning),
        stop: () => {
          isRunning = false
          return { stopped: true, pid: 101 }
        },
      },
      install: async () => ({
        plistPath: "/tmp/io.leuco.daemon.plist",
        label: "io.leuco.daemon",
      }),
      verify: async () => new Error("gateway timeout; log: /tmp/leuco.log"),
      rollback: async () => {
        calls.push("rollback")
        return new Error("bootout denied")
      },
      restore: async () => {
        calls.push("restore")
        return { mode: "detached", pid: 202, logPath: "/tmp/leuco.log" }
      },
    })

    expect(installed).toEqual(
      new Error(
        "LaunchAgent gateway readiness failed (gateway timeout; log: /tmp/leuco.log); rollback failed: bootout denied",
      ),
    )
    expect(calls).toEqual(["rollback"])
  })

  it("rolls back an unhealthy first install without starting an unrequested daemon", async () => {
    const calls: string[] = []

    const installed = await installLaunchAgentSafely({
      daemon: {
        status: () => status(false),
        stop: () => ({ stopped: false, pid: null }),
      },
      install: async () => ({
        plistPath: "/tmp/io.leuco.daemon.plist",
        label: "io.leuco.daemon",
      }),
      verify: async () => new Error("gateway timeout; log: /tmp/leuco.log"),
      rollback: async () => {
        calls.push("rollback")
      },
      restore: async () => {
        calls.push("restore")
        return { mode: "detached", pid: 202, logPath: "/tmp/leuco.log" }
      },
    })

    expect(installed).toEqual(
      new Error("LaunchAgent gateway readiness failed: gateway timeout; log: /tmp/leuco.log"),
    )
    expect(calls).toEqual(["rollback"])
  })
})
