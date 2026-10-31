import { beforeEach, expect, it, vi } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import type { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import type { LeucoCodexClientProps } from "@/engine/codex/codex-client"

const fixture = vi.hoisted(() => {
  const notifications: Array<(method: string, params: unknown, requestId?: string) => void> = []
  const clients: MemoryCodexClient[] = []
  return { notifications, clients }
})
vi.mock("@/engine/codex/codex-client", async () => {
  const memory = await import("@/engine/codex/memory-codex-client")
  return {
    LeucoCodexClient: class extends memory.MemoryCodexClient {
      constructor(props: LeucoCodexClientProps) {
        super()
        fixture.clients.push(this)
        if (props.onAnyNotification) fixture.notifications.push(props.onAnyNotification)
      }
    },
  }
})
beforeEach(() => {
  fixture.notifications.length = 0
  fixture.clients.length = 0
})
it("masks complete notification secrets before every diagnostic clipping stage", async () => {
  const events = new LeucoEventLog()
  const secret = `private-control-${"s".repeat(512)}`
  events.addRedactionSecrets([secret])
  const runtime = LeucoRuntime.build({
    store: new MemoryLeucoStore(),
    eventLog: events,
    connections: [],
    env: {},
  })
  try {
    await runtime.start()
    const notify = fixture.notifications[0]!
    notify("probe", { text: `${"x".repeat(7500)}${secret}${"y".repeat(30000)}` })
    notify(`${"m".repeat(240)}${secret}`, {})
    notify("item/completed", {
      threadId: "thread",
      turnId: "turn",
      item: { type: "mcpToolCall", tool: `${"t".repeat(240)}${secret}`, result: {} },
    })
    const history = events.query({ type: "codex.notification" }).map((entry) => entry.event)
    expect(JSON.stringify(history)).not.toContain("private-control")
    expect(JSON.stringify(history)).toContain("[redacted]")
    expect(history[1]).toMatchObject({ method: `${"m".repeat(240)}[redacted]` })
    expect(history[2]).toMatchObject({
      params: { item: { tool: `${"t".repeat(240)}[redacted]`, hasResult: true } },
    })
  } finally {
    await runtime.stop()
    events.close()
  }
})
it("drops streaming deltas before taking a diagnostic JSON snapshot", async () => {
  const events = new LeucoEventLog()
  const snapshot = vi.spyOn(events, "redactValue")
  const runtime = LeucoRuntime.build({
    store: new MemoryLeucoStore(),
    eventLog: events,
    connections: [],
    env: {},
  })
  try {
    await runtime.start()
    snapshot.mockClear()
    fixture.notifications[0]!("item/agentMessage/delta", {
      toJSON() {
        throw new Error("delta must not be inspected")
      },
    })
    expect(snapshot).not.toHaveBeenCalled()
    expect(events.query({ type: "codex.notification" })).toEqual([])
  } finally {
    await runtime.stop()
    events.close()
  }
})

it("does not serialize command results discarded from completed-item diagnostics", async () => {
  const events = new LeucoEventLog()
  const serializeResult = vi.fn(() => {
    throw new Error("discarded command result was serialized")
  })
  const runtime = LeucoRuntime.build({
    store: new MemoryLeucoStore(),
    eventLog: events,
    connections: [],
    env: {},
  })
  try {
    await runtime.start()
    fixture.notifications[0]!("item/completed", {
      threadId: "thread",
      turnId: "turn",
      item: { type: "mcpToolCall", tool: "probe", result: { toJSON: serializeResult } },
    })
    expect(serializeResult).not.toHaveBeenCalled()
    expect(events.query({ type: "codex.notification" })[0]?.event).toMatchObject({
      params: { item: { tool: "probe", hasResult: true } },
    })
  } finally {
    await runtime.stop()
    events.close()
  }
})

it("attributes only transport-confirmed notifications to the active request", async () => {
  const events = new LeucoEventLog()
  const runtime = LeucoRuntime.build({
    store: new MemoryLeucoStore(),
    eventLog: events,
    connections: [],
    env: {},
  })
  try {
    await runtime.start()
    const client = fixture.clients[0]!
    client.hold = true
    const reply = runtime.runTextTurn("cli", "hold", "current-request")
    await vi.waitFor(() => expect(client.turns).toHaveLength(1))
    const notify = fixture.notifications[0]!
    notify("background/probe", {})
    notify("item/completed", {
      threadId: "other-thread",
      turnId: "other-turn",
      item: { type: "reasoning" },
    })
    notify("item/completed", {
      threadId: "thread-1",
      turnId: "old-turn",
      item: { type: "reasoning" },
    })
    notify(
      "item/completed",
      { threadId: "thread-1", turnId: "current-turn", item: { type: "reasoning" } },
      "current-request",
    )
    expect(events.query({ type: "codex.notification", requestId: "current-request" })).toHaveLength(
      1,
    )
    expect(events.query({ type: "codex.notification" })).toHaveLength(4)
    client.complete("done")
    expect(await reply).toBe("done")
  } finally {
    await runtime.stop()
    events.close()
  }
})
