import { describe, expect, it } from "vitest"
import { formatTurnFailureReply } from "@/channels/slack/format-turn-failure-reply"

describe("formatTurnFailureReply", () => {
  it("keeps the underlying error without claiming recovery", () => {
    const reply = formatTurnFailureReply(new Error("selected model is at capacity"))

    expect(reply).toBe("```\nselected model is at capacity\n```")
    expect(reply).not.toContain("restarted")
  })

  it("redacts common credentials", () => {
    const reply = formatTurnFailureReply(
      new Error("Bearer abc123 xoxb-token-value api_key=top-secret sk-proj-abcdefghijk"),
    )

    expect(reply).not.toContain("abc123")
    expect(reply).not.toContain("token-value")
    expect(reply).not.toContain("top-secret")
    expect(reply).not.toContain("abcdefghijk")
    expect(reply.match(/\[REDACTED\]/g)).toHaveLength(4)
  })

  it("redacts credentials embedded in JSON", () => {
    const reply = formatTurnFailureReply(
      new Error('{"Authorization":"Bearer auth-value","token":"json-value"}'),
    )

    expect(reply).not.toContain("auth-value")
    expect(reply).not.toContain("json-value")
    expect(reply.match(/\[REDACTED\]/g)).toHaveLength(2)
  })

  it("cannot break out of the Slack code block", () => {
    const reply = formatTurnFailureReply(new Error("bad ``` <!channel>"))

    expect(reply.match(/```/g)).toHaveLength(2)
    expect(reply).toContain("bad ` ` ` <!channel>")
  })
})
