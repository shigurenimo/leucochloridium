import { describe, expect, it } from "vitest"
import { leucoEventSchema } from "@/events/leuco-event-schema"

describe("leucoEventSchema", () => {
  it("accepts a well-formed log event", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "log",
      level: "info",
      line: "hello",
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts a turn.complete envelope", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "turn.complete",
      project: "p",
      threadKey: "t",
      reply: "ok",
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts turn queue metrics and codex recovery outcomes", () => {
    const queued = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "turn.queued",
      project: "p",
      threadKey: "t",
      queueDepth: 2,
    })
    const recovered = leucoEventSchema.safeParse({
      ts: 1700000000100,
      type: "codex.recovery",
      project: "p",
      reason: "codex turn idle timed out after 120s",
      status: "succeeded",
      durationMs: 250,
      error: null,
    })

    expect(queued.success).toBe(true)
    expect(recovered.success).toBe(true)
  })

  it("accepts a structured turn.rejected event", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "turn.rejected",
      project: "p",
      threadKey: "t",
      reason: "queue_bytes_limit",
      queueDepth: 2,
      queueBytes: 1024,
      inputBytes: 512,
      maxQueueDepth: 64,
      maxQueueBytes: 262144,
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts a Codex child recovery outcome", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "codex.recovery",
      project: "p",
      reason: "codex command output exceeded 200000 chars from call_123",
      status: "succeeded",
      durationMs: 250,
      error: null,
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts a slack.event with a message payload", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "slack.event",
      project: "p",
      connector: "c",
      event: {
        kind: "message",
        channel: "C123",
        user: "U123",
        rawText: "<@U999> hi",
        text: "hi",
        threadTs: "1.0",
        ts: "1.0",
        isThreadRoot: true,
        mentioned: true,
        source: "app_mention",
      },
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts a slack.connection event", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "slack.connection",
      project: "p",
      connector: "c",
      status: "reconnecting",
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts a slack.error event", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "slack.error",
      project: "p",
      connector: "c",
      level: "warn",
      action: "ws.close",
      message: "socket closed",
      error: null,
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts runtime retry details on an supervisor.reconcile.failed event", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "supervisor.reconcile.failed",
      reason: "runtime demo start failed: offline",
      project: "demo",
      attempt: 2,
      retryAt: 1700000060000,
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects unknown discriminator values", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "made.up.type",
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects events missing required fields", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "turn.complete",
      project: "p",
    })
    expect(parsed.success).toBe(false)
  })
})
