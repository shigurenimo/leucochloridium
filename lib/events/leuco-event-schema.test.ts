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
      agent: "a",
      threadKey: "t",
      reply: "ok",
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts a slack.event with a message payload", () => {
    const parsed = leucoEventSchema.safeParse({
      ts: 1700000000000,
      type: "slack.event",
      project: "p",
      agent: "a",
      channel: "c",
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
      type: "tenant.started",
      project: "p",
    })
    expect(parsed.success).toBe(false)
  })
})
