import { describe, expect, it } from "vitest"
import { toDaemonDoctorChecks } from "@/cli/utils/to-daemon-doctor-checks"

describe("toDaemonDoctorChecks", () => {
  it("reports a running daemon from a versioned pid lease", () => {
    const checks = toDaemonDoctorChecks({
      daemonStatus: {
        pid: 76633,
        isRunning: true,
        identityVerified: true,
        pidPath: "/state/daemon/pid",
        logPath: "/state/daemon/log",
      },
      hasPidFile: true,
      pidText: '{"version":1,"pid":76633,"processIdentity":"87670ca3de9dfed0dec936d234c4eb95b"}',
      logAgeSeconds: 3,
    })

    expect(checks).toEqual({
      pid: { status: "ok", message: "pid 76633" },
      process: { status: "ok", message: "process 76633 alive" },
      log: { status: "ok", message: "log active (3s ago)" },
    })
  })
})
