import { describe, expect, it } from "vitest"
import {
  CodexPendingNotifications,
  pendingNotificationMaxBytes,
  pendingNotificationMaxRecords,
} from "@/engine/codex/codex-pending-notifications"

describe("CodexPendingNotifications", () => {
  it("retains ordered snapshots and releases them on drain", () => {
    const buffer = new CodexPendingNotifications()
    const notification = { delta: "first" }
    buffer.push("delta", notification)
    notification.delta = "changed"
    buffer.push("done", { status: "completed" })
    expect(buffer.drain()).toEqual([
      { method: "delta", params: { delta: "first" } },
      { method: "done", params: { status: "completed" } },
    ])
    expect(buffer.drain()).toEqual([])
  })

  it("rejects excess records without retaining them and resets after clear", () => {
    const buffer = new CodexPendingNotifications()
    for (const _ of Array.from({ length: pendingNotificationMaxRecords })) buffer.push("d", {})
    expect(() => buffer.push("d", {})).toThrow("pending turn notifications exceeded limit")
    expect(buffer.drain()).toHaveLength(pendingNotificationMaxRecords)
    buffer.push("d", {})
    buffer.clear()
    expect(buffer.drain()).toEqual([])
    buffer.push("d", {})
    expect(buffer.drain()).toHaveLength(1)
  })

  it("counts UTF-8 bytes and restores the byte budget after draining", () => {
    const buffer = new CodexPendingNotifications()
    const payload = "😀".repeat(Math.ceil(pendingNotificationMaxBytes / 8))
    buffer.push("d", payload)
    expect(() => buffer.push("d", payload)).toThrow("pending turn notifications exceeded limit")
    expect(buffer.drain()).toEqual([{ method: "d", params: payload }])
    buffer.push("d", payload)
    buffer.clear()
    buffer.push("d", payload)
  })

  it("rejects values without JSON representation without poisoning the buffer", () => {
    const buffer = new CodexPendingNotifications()
    expect(() => buffer.push("d", undefined)).toThrow("not JSON")
    expect(() => buffer.push("d", 1n)).toThrow()
    buffer.push("d", null)
    expect(buffer.drain()).toEqual([{ method: "d", params: null }])
  })
})
