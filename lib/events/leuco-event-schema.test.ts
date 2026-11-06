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
      threadKey: "t",
      reply: "ok",
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts turn queue metrics", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "turn.queued",
      threadKey: "t",
      queueDepth: 2,
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts a structured turn.rejected event", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "turn.rejected",
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

  it("accepts a slack.event with a message payload", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "slack.event",
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
      status: "reconnecting",
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts a slack.error event", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "slack.error",
      level: "warn",
      action: "ws.close",
      message: "socket closed",
      error: null,
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
    })
    expect(parsed.success).toBe(false)
  })
})
