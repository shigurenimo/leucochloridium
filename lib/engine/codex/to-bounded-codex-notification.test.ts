import { describe, expect, it } from "vitest"
import { z } from "zod"
import { toBoundedJsonValue } from "@/engine/codex/to-bounded-json-value"
import { toBoundedCodexNotification } from "@/engine/codex/to-bounded-codex-notification"
import { MAX_CODEX_NOTIFICATION_PARAMS_CHARS } from "@/engine/codex/to-bounded-json-value"

describe("toBoundedCodexNotification", () => {
  it.each([
    ["commandExecution", "aggregatedOutput"],
    ["mcpToolCall", "result"],
    ["dynamicToolCall", "contentItems"],
  ])("summarizes %s with unavailable execution measurements", (type, payloadField) => {
    const marker = "large-tool-body"
    const notification = toBoundedCodexNotification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type,
        id: "item-1",
        status: "failed",
        durationMs: null,
        ...(type === "commandExecution" ? { exitCode: null } : {}),
        [payloadField]: marker.repeat(100_000),
      },
    })
    expect(notification?.params).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type, id: "item-1", status: "failed", durationMs: null, exitCode: null },
    })
    expect(JSON.stringify(notification)).not.toContain(marker)
  })
  it.each(["item/agentMessage/delta", "item/commandExecution/outputDelta"])(
    "does not persist streaming notification %s",
    (method) => {
      expect(toBoundedCodexNotification(method, { delta: "large" })).toBeNull()
    },
  )

  it.each([undefined, null])(
    "keeps item/completed correlation metadata without its large result (phase: %j)",
    (phase) => {
      const marker = "sensitive-large-result"
      const notification = toBoundedCodexNotification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "item-1",
          server: "leuco",
          tool: "external_lookup",
          status: "completed",
          phase,
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
            tool: "external_lookup",
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
    },
  )

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

it("keeps method and completed metadata on whole Unicode characters", () => {
  const original = `${"x".repeat(255)}😀discarded`
  expect(toBoundedCodexNotification(original, {})?.method).toBe("x".repeat(255))
  const summary = toBoundedCodexNotification("item/completed", {
    threadId: original,
    turnId: original,
    item: {
      type: original,
      id: original,
      status: original,
      phase: original,
      server: original,
      tool: original,
    },
  })
  expect(summary?.params).toMatchObject({
    threadId: "x".repeat(255),
    turnId: "x".repeat(255),
    item: {
      type: "x".repeat(255),
      id: "x".repeat(255),
      status: "x".repeat(255),
      phase: "x".repeat(255),
      server: "x".repeat(255),
      tool: "x".repeat(255),
    },
  })
})

it("keeps JSON preview Unicode intact and reports its actual retained length", () => {
  const schema = z.object({ preview: z.string(), _leuco: z.object({ previewChars: z.number() }) })
  const probe = schema.parse(toBoundedJsonValue({ payload: "x".repeat(30000) }))
  const prefix = '{"payload":"'
  const payloadPrefix = "x".repeat(probe._leuco.previewChars - prefix.length - 1)
  const bounded = schema.parse(
    toBoundedJsonValue({ payload: `${payloadPrefix}😀${"y".repeat(30000)}` }),
  )
  expect(bounded.preview).toBe(`${prefix}${payloadPrefix}`)
  expect(bounded._leuco.previewChars).toBe(bounded.preview.length)
  expect(JSON.stringify(bounded)).not.toContain("\\ud83d")
})
