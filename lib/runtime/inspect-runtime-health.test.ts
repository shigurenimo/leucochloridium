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
  it("exposes connector log delivery failures without restarting a connected transport", () => {
    const diagnosis = inspectRuntimeHealth({
      ...status,
      runtime: {
        ...status.runtime,
        connections: [
          { name: "slack", health: { state: "connected", diagnostics: { healthy: false } } },
        ],
      },
    })
    expect(diagnosis).toMatchObject({ healthy: false, restartRecommended: false })
    expect(diagnosis.issues).toContain(
      "Connector slack log delivery is degraded; inspect its diagnostic causes and log destinations",
    )
  })
  it.each(["starting", "stopping", "cleaningUp"])(
    "observes Codex %s instead of recommending another restart",
    (phase) => {
      const diagnosis = inspectRuntimeHealth({
        ...status,
        runtime: { ...status.runtime, codexRunning: false, codex: { [phase]: true } },
      })
      expect(diagnosis.healthy).toBe(false)
      expect(diagnosis.restartRecommended).toBe(false)
      expect(diagnosis.issues[0]).toContain("observe status")
    },
  )
  it("does not hide an independently disconnected connector during Codex startup", () => {
    expect(
      inspectRuntimeHealth({
        ...status,
        runtime: {
          ...status.runtime,
          codexRunning: false,
          codex: { starting: true },
          connections: [{ name: "slack", health: { state: "disconnected" } }],
        },
      }).restartRecommended,
    ).toBe(true)
  })
  it("recommends recovery after Codex is unavailable and all transition flags clear", () => {
    expect(
      inspectRuntimeHealth({
        ...status,
        runtime: {
          ...status.runtime,
          codexRunning: false,
          codex: { starting: false, stopping: false, cleaningUp: false },
        },
      }),
    ).toMatchObject({ healthy: false, restartRecommended: true })
  })
  it("does not report a transitioning child healthy even if its running flag has not cleared", () => {
    expect(
      inspectRuntimeHealth({
        ...status,
        runtime: { ...status.runtime, codex: { stopping: true } },
      }),
    ).toMatchObject({ healthy: false, restartRecommended: false })
  })
})

it("exposes a failed host observer without recommending a transport restart", () => {
  expect(
    inspectRuntimeHealth({
      ready: true,
      runtime: { codexRunning: true, logConsumer: { healthy: false } },
    }),
  ).toMatchObject({
    healthy: false,
    restartRecommended: false,
    issues: [expect.stringContaining("Runtime log consumer is degraded")],
  })
})

it("reports schedule errors without restarting a healthy Codex and Slack connection", () => {
  const diagnosis = inspectRuntimeHealth({
    ready: true,
    runtime: {
      codexRunning: true,
      connections: [
        { name: "slack", type: "slack", health: { state: "connected" } },
        { name: "schedule", type: "schedule", health: { state: "error" } },
      ],
    },
  })
  expect(diagnosis).toMatchObject({ healthy: false, restartRecommended: false })
  expect(diagnosis.issues).toEqual([expect.stringContaining("settings, storage and turn errors")])
})

it.each(["codex", "slack"])(
  "does not hide an independent %s failure behind a schedule error",
  (failure) => {
    const diagnosis = inspectRuntimeHealth({
      ready: true,
      runtime: {
        codexRunning: failure !== "codex",
        connections: [
          {
            name: "slack",
            type: "slack",
            health: { state: failure === "slack" ? "disconnected" : "connected" },
          },
          { name: "schedule", type: "schedule", health: { state: "error" } },
        ],
      },
    })
    expect(diagnosis).toMatchObject({ healthy: false, restartRecommended: true })
  },
)

it("reports Codex diagnostic delivery failure without recommending a restart", () => {
  const diagnosis = inspectRuntimeHealth({
    ready: true,
    runtime: { codexRunning: true, codex: { diagnostics: { healthy: false } } },
  })
  expect(diagnosis).toMatchObject({ healthy: false, restartRecommended: false })
  expect(diagnosis.issues).toEqual([
    expect.stringContaining("runtime.codex.diagnostics.lastFailure"),
  ])
})
