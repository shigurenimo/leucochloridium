import { describe, expect, it } from "vitest"
import { toBoundedCodexNotification } from "@/engine/codex/to-bounded-codex-notification"
import { MAX_CODEX_NOTIFICATION_PARAMS_CHARS } from "@/engine/codex/to-bounded-json-value"

describe("toBoundedCodexNotification", () => {
  it.each(["item/agentMessage/delta", "item/commandExecution/outputDelta"])(
    "does not persist streaming notification %s",
    (method) => {
      expect(toBoundedCodexNotification(method, { delta: "large" })).toBeNull()
    },
  )

  it("keeps item/completed correlation metadata without its large result", () => {
    const marker = "sensitive-large-result"
    const notification = toBoundedCodexNotification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "mcpToolCall",
        id: "item-1",
        server: "leuco",
        tool: "slack_call",
        status: "completed",
        durationMs: 250,
        arguments: { query: "hello" },
        result: { content: marker.repeat(100_000) },
      },
    })

    expect(notification).toEqual({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "item-1",
          status: "completed",
          phase: null,
          server: "leuco",
          tool: "slack_call",
          durationMs: 250,
          exitCode: null,
          textChars: null,
          hasArguments: true,
          hasResult: true,
          hasError: false,
        },
      },
    })
    expect(JSON.stringify(notification)).not.toContain(marker)
  })

  it("bounds unknown notification params while preserving a useful preview", () => {
    const notification = toBoundedCodexNotification("future/notification", {
      payload: '\\"\n'.repeat(100_000),
    })
    if (notification === null) throw new Error("notification was unexpectedly dropped")

    expect(JSON.stringify(notification.params).length).toBeLessThanOrEqual(
      MAX_CODEX_NOTIFICATION_PARAMS_CHARS,
    )
    expect(notification.params).toEqual(
      expect.objectContaining({
        _leuco: expect.objectContaining({
          truncated: true,
          originalChars: expect.any(Number),
          previewChars: expect.any(Number),
        }),
        preview: expect.any(String),
      }),
    )
  })

  it("preserves a small unknown notification", () => {
    expect(toBoundedCodexNotification("future/notification", { ok: true })).toEqual({
      method: "future/notification",
      params: { ok: true },
    })
  })
})
