import { describe, expect, it } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"
describe("runtime inspection", () => {
  it("shows active and waiting request IDs and correlates completion without exposing input in status", async () => {
    const codex = new MemoryCodexClient()
    codex.hold = true
    const events = new LeucoEventLog()
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex,
      eventLog: events,
      connections: [],
      env: {},
    })
    await runtime.start()
    const first = runtime.runTextTurn("first", "private prompt", "request-one")
    for (const _ of Array.from({ length: 20 })) await Promise.resolve()
    const second = runtime.runTextTurn("second", "other prompt", "request-two")
    expect(runtime.getStatus()).toMatchObject({
      active: { requestId: "request-one" },
      queue: { waiting: 1, requests: [{ requestId: "request-two" }] },
    })
    expect(JSON.stringify(runtime.getStatus())).not.toContain("private prompt")
    codex.complete("done")
    expect(await first).toBe("done")
    for (const _ of Array.from({ length: 20 })) await Promise.resolve()
    codex.complete("done-two")
    expect(await second).toBe("done-two")
    const firstEvents = events.query().filter((entry) => entry.event.requestId === "request-one")
    expect(firstEvents.map((entry) => entry.event.type)).toEqual([
      "turn.queued",
      "turn.start",
      "turn.complete",
    ])
    expect(firstEvents.every((entry) => entry.event.instanceId === runtime.instanceId)).toBe(true)
    await runtime.stop()
  })
  it("records rejected requests and every queued cancellation without treating shutdown as a failure", async () => {
    const codex = new MemoryCodexClient()
    codex.hold = true
    const events = new LeucoEventLog()
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex,
      eventLog: events,
      connections: [],
      env: {},
    })
    await runtime.start()
    const held = runtime.runTextTurn("held", "hold", "held-id")
    for (const _ of Array.from({ length: 20 })) await Promise.resolve()
    const queued = runtime.runTextTurn("queued", "wait", "queued-id")
    expect(
      await runtime.runTextTurn("too-big", "x".repeat(256 * 1024), "rejected-id"),
    ).toBeInstanceOf(Error)
    expect(
      events.query().find((entry) => entry.event.requestId === "rejected-id")?.event,
    ).toMatchObject({ type: "turn.rejected", reason: "queue_bytes_limit" })
    await runtime.stop()
    expect(await held).toBeInstanceOf(Error)
    expect(await queued).toBeInstanceOf(Error)
    expect(runtime.getStatus().lastFailure).toBe(null)
    expect(
      events
        .query()
        .find((entry) => entry.event.requestId === "queued-id" && entry.event.type === "turn.error")
        ?.event,
    ).toMatchObject({ cancelled: true })
  })
})
