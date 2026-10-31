import { expect, it } from "vitest"
import {
  agentMessageDeltaSchema,
  itemCompletedSchema,
  turnCompletedSchema,
  turnNotificationIdentitySchema,
  turnStartResultSchema,
} from "@/engine/codex/codex-schemas"

it.each(["", " ", "\t\n"])(
  "rejects a blank execution ID in acknowledgments and notifications: %j",
  (id) => {
    expect(turnStartResultSchema.safeParse({ turn: { id } }).success).toBe(false)
    expect(
      turnCompletedSchema.safeParse({ threadId: "thread-1", turn: { id, status: "completed" } })
        .success,
    ).toBe(false)
    expect(
      turnNotificationIdentitySchema.safeParse({ threadId: "thread-1", turnId: id }).success,
    ).toBe(false)
    expect(
      turnNotificationIdentitySchema.safeParse({ threadId: "thread-1", turn: { id } }).success,
    ).toBe(false)
    expect(
      agentMessageDeltaSchema.safeParse({
        threadId: "thread-1",
        turnId: id,
        itemId: "item-1",
        delta: "text",
      }).success,
    ).toBe(false)
    expect(
      itemCompletedSchema.safeParse({
        threadId: "thread-1",
        turnId: id,
        item: { type: "agentMessage", text: "done" },
      }).success,
    ).toBe(false)
  },
)

it("preserves a valid opaque execution ID verbatim", () => {
  const id = " opaque-turn-id "
  expect(turnStartResultSchema.parse({ turn: { id } }).turn.id).toBe(id)
  expect(
    turnCompletedSchema.parse({ threadId: "thread-1", turn: { id, status: "completed" } }).turn.id,
  ).toBe(id)
})

it.each([
  { turnId: "current", turn: { id: "old" } },
  { turnId: "old", turn: { id: "current" } },
  {},
])("rejects missing or conflicting notification identities: %j", (identity) => {
  expect(
    turnNotificationIdentitySchema.safeParse({ threadId: "thread-1", ...identity }).success,
  ).toBe(false)
})
