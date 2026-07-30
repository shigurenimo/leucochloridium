import { describe, expect, it } from "vitest"
import { leucoEventReadSchema } from "@/events/leuco-event-read-schema"

describe("leucoEventReadSchema", () => {
  it("maps legacy Slack channel fields to connectors", () => {
    const parsed = leucoEventReadSchema.parse({
      ts: 1700000000000,
      type: "slack.error",
      project: "demo",
      channel: "slack",
      level: "error",
      action: "turn.failed",
      message: "failed",
      error: null,
    })

    expect(parsed).toEqual({
      ts: 1700000000000,
      type: "slack.error",
      project: "demo",
      connector: "slack",
      level: "error",
      action: "turn.failed",
      message: "failed",
      error: null,
    })
  })

  it.each([
    ["tenant.started", "runtime.started"],
    ["tenant.stopped", "runtime.stopped"],
  ])("maps legacy %s lifecycle events to %s", (type, expected) => {
    const parsed = leucoEventReadSchema.parse({
      ts: 1700000000000,
      type,
      project: "demo",
    })

    expect(parsed.type).toBe(expected)
  })

  it("maps legacy engine and turn rejection names", () => {
    const reconcile = leucoEventReadSchema.parse({
      ts: 1700000000000,
      type: "engine.reconcile",
      added: ["demo"],
      removed: [],
    })
    const rejected = leucoEventReadSchema.parse({
      ts: 1700000000000,
      type: "turn.rejected",
      project: "demo",
      threadKey: "thread",
      reason: "tenant_stopped",
      queueDepth: 0,
      queueBytes: 0,
      inputBytes: 5,
      maxQueueDepth: 64,
      maxQueueBytes: 1024,
    })

    expect(reconcile.type).toBe("supervisor.reconcile")
    expect(rejected).toMatchObject({
      type: "turn.rejected",
      reason: "runtime_stopped",
    })
  })
})
