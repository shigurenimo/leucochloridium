import { describe, expect, it } from "vitest"
import { NodeDaemonReadiness } from "@/daemon/node-daemon-readiness"

const healthResponse = {
  statusCode: 200,
  bodyText: JSON.stringify({ ok: true, pid: 70750 }),
}

describe("NodeDaemonReadiness", () => {
  it("returns the healthy daemon pid", async () => {
    const readiness = new NodeDaemonReadiness({
      requestHealth: async () => healthResponse,
    })

    const pid = await readiness.getHealthyPid({ port: 7331, timeoutMs: 1_000 })

    expect(pid).toBe(70750)
    expect(readiness.getDiagnostic()).toBeNull()
  })

  it("rejects a non-successful health response", async () => {
    const readiness = new NodeDaemonReadiness({
      requestHealth: async () => ({ ...healthResponse, statusCode: 503 }),
    })

    const pid = await readiness.getHealthyPid({ port: 7331, timeoutMs: 1_000 })

    expect(pid).toBeNull()
    expect(readiness.getDiagnostic()).toBe("HTTP 503")
  })

  it("rejects an invalid health response", async () => {
    const readiness = new NodeDaemonReadiness({
      requestHealth: async () => ({ ...healthResponse, bodyText: '{"ok":false}' }),
    })

    const pid = await readiness.getHealthyPid({ port: 7331, timeoutMs: 1_000 })

    expect(pid).toBeNull()
    expect(readiness.getDiagnostic()).toBe("invalid JSON response")
  })

  it("reports a health request failure", async () => {
    const readiness = new NodeDaemonReadiness({
      requestHealth: async () => {
        throw new Error("connection reset")
      },
    })

    const pid = await readiness.getHealthyPid({ port: 7331, timeoutMs: 1_000 })

    expect(pid).toBeNull()
    expect(readiness.getDiagnostic()).toBe("connection reset")
  })
})
