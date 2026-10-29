import { describe, expect, it } from "vitest"
import { inspectRuntimeHealth } from "@/runtime/inspect-runtime-health"

describe("operational health", () => {
  const status = { ready: true, runtime: { codexRunning: true } }
  it("does not call an alive daemon healthy when Slack is disconnected or schedule storage is broken", () => {
    for (const state of ["disconnected", "error"]) {
      const health = inspectRuntimeHealth({
        ...status,
        runtime: { ...status.runtime, connections: [{ name: "input", health: { state } }] },
      })
      expect(health.healthy).toBe(false)
      expect(health.restartRecommended).toBe(true)
      expect(health.issues[0]).toContain(state)
    }
  })
  it("exposes persistence failures without suggesting restart as a disk repair", () => {
    const health = inspectRuntimeHealth({
      ...status,
      runtime: { ...status.runtime, logs: { lastWriteFailed: true } },
    })
    expect(health.healthy).toBe(false)
    expect(health.restartRecommended).toBe(false)
  })
  it("distinguishes temporary reconnecting/startup from a restart recommendation", () => {
    expect(
      inspectRuntimeHealth({
        ...status,
        runtime: {
          ...status.runtime,
          connections: [{ name: "slack", health: { state: "reconnecting" } }],
        },
      }),
    ).toMatchObject({ healthy: false, restartRecommended: false })
    expect(inspectRuntimeHealth({ ...status, ready: false })).toMatchObject({
      healthy: false,
      restartRecommended: false,
    })
    expect(inspectRuntimeHealth({ ready: true })).toMatchObject({
      healthy: false,
      restartRecommended: false,
    })
    expect(inspectRuntimeHealth(status).healthy).toBe(true)
  })
})
