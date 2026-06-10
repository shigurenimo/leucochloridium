import { describe, expect, it } from "vitest"
import {
  formatZodIssue,
  scheduleCreateArgsSchema,
  scheduleDeleteArgsSchema,
  scheduleListArgsSchema,
  slackCallArgsSchema,
  slackDownloadFileArgsSchema,
} from "@/mcp/mcp-tool-schemas"

describe("slackCallArgsSchema", () => {
  it("accepts a minimal call with only method", () => {
    const parsed = slackCallArgsSchema.safeParse({ method: "chat.postMessage" })
    expect(parsed.success).toBe(true)
  })

  it("rejects an empty method", () => {
    const parsed = slackCallArgsSchema.safeParse({ method: "" })
    expect(parsed.success).toBe(false)
  })

  it("rejects a missing method", () => {
    const parsed = slackCallArgsSchema.safeParse({})
    expect(parsed.success).toBe(false)
  })

  it("rejects a non-object body", () => {
    const parsed = slackCallArgsSchema.safeParse({ method: "x", body: "stringy" })
    expect(parsed.success).toBe(false)
  })

  it("accepts a body object", () => {
    const parsed = slackCallArgsSchema.safeParse({
      method: "chat.postMessage",
      body: { channel: "C123", text: "hi" },
    })
    expect(parsed.success).toBe(true)
  })
})

describe("slackDownloadFileArgsSchema", () => {
  it("accepts file_id", () => {
    const parsed = slackDownloadFileArgsSchema.safeParse({ file_id: "F123" })
    expect(parsed.success).toBe(true)
  })

  it("accepts url", () => {
    const parsed = slackDownloadFileArgsSchema.safeParse({
      url: "https://files.slack.com/files-pri/T-F/download/image.png",
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects missing file_id and url", () => {
    const parsed = slackDownloadFileArgsSchema.safeParse({})
    expect(parsed.success).toBe(false)
  })

  it("rejects both file_id and url", () => {
    const parsed = slackDownloadFileArgsSchema.safeParse({
      file_id: "F123",
      url: "https://files.slack.com/files-pri/T-F/download/image.png",
    })
    expect(parsed.success).toBe(false)
  })
})

describe("scheduleCreateArgsSchema", () => {
  it("requires name, run_at, and prompt", () => {
    const parsed = scheduleCreateArgsSchema.safeParse({ name: "x" })
    expect(parsed.success).toBe(false)
  })

  it("accepts a full set of fields", () => {
    const parsed = scheduleCreateArgsSchema.safeParse({
      name: "morning",
      run_at: "0 9 * * *",
      prompt: "ping",
      channel_name: "cron",
    })
    expect(parsed.success).toBe(true)
  })
})

describe("scheduleDeleteArgsSchema", () => {
  it("requires id_or_name", () => {
    const parsed = scheduleDeleteArgsSchema.safeParse({})
    expect(parsed.success).toBe(false)
  })

  it("accepts id_or_name only", () => {
    const parsed = scheduleDeleteArgsSchema.safeParse({ id_or_name: "abc" })
    expect(parsed.success).toBe(true)
  })
})

describe("scheduleListArgsSchema", () => {
  it("accepts an empty object", () => {
    const parsed = scheduleListArgsSchema.safeParse({})
    expect(parsed.success).toBe(true)
  })

  it("accepts an optional channel_name", () => {
    const parsed = scheduleListArgsSchema.safeParse({ channel_name: "cron" })
    expect(parsed.success).toBe(true)
  })
})

describe("formatZodIssue", () => {
  it("includes the field path when present", () => {
    const parsed = slackCallArgsSchema.safeParse({})
    if (parsed.success) throw new Error("expected failure")
    const message = formatZodIssue(parsed.error)
    expect(message).toMatch(/method/)
  })
})
