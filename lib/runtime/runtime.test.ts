import { afterEach, describe, expect, it, vi } from "vitest"
import type { Connector } from "@/connectors/connector"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"

const active: LeucoRuntime[] = []
afterEach(async () => {
  for (const runtime of active.splice(0)) await runtime.stop()
  vi.useRealTimers()
})

function create(
  store = new MemoryLeucoStore(),
  codex = new MemoryCodexClient(),
  soul?: string | null,
) {
  const eventLog = new LeucoEventLog()
  const runtime = LeucoRuntime.build({
    cwd: "/work",
    home: "/state",
    env: {},
    store,
    codex,
    eventLog,
    connections: [],
    ...(soul === undefined ? {} : { soul }),
  })
  active.push(runtime)
  return { runtime, codex, store, eventLog }
}

async function flush(): Promise<void> {
  for (const _ of Array.from({ length: 15 })) await Promise.resolve()
}

describe("single companion runtime", () => {
  it("starts a native Codex conversation without custom instructions or policy overrides", async () => {
    const fixture = create()
    await fixture.runtime.start()
    expect(await fixture.runtime.runTextTurn("cli", "hello")).toBe("done")
    expect(fixture.codex.starts).toEqual([{ cwd: "/work" }])
    expect(fixture.store.loadSettings().soul).toBeNull()
    expect(Object.keys(fixture.store.loadState().threads)).toEqual(["cli"])
  })

  it("appends the selected SOUL to existing native developer instructions", async () => {
    const fixture = create(new MemoryLeucoStore(), new MemoryCodexClient(), "/SOUL.md")
    fixture.codex.nativeInstructions = "native instructions"
    fixture.store.instructions.set("/SOUL.md", "my soul")
    await fixture.runtime.start()
    await fixture.runtime.runTextTurn("cli", "hello")
    expect(fixture.codex.starts[0]?.developerInstructions).toBe("native instructions\n\nmy soul")
    expect(fixture.store.loadSettings().soul).toBeNull()
  })

  it("uses a saved soul unless explicitly disabled", async () => {
    const fixture = create(new MemoryLeucoStore({ soul: "/SOUL.md" }))
    fixture.store.instructions.set("/SOUL.md", "soul")
    await fixture.runtime.start()
    await fixture.runtime.runTextTurn("cli", "first")
    await fixture.runtime.stop()
    const plain = create(fixture.store, new MemoryCodexClient(), null)
    await plain.runtime.start()
    await plain.runtime.runTextTurn("cli", "second")
    expect(plain.codex.resumes).toEqual([])
    expect(plain.codex.starts).toEqual([{ cwd: "/work" }])
    expect(fixture.store.loadSettings().soul).toBe("/SOUL.md")
  })

  it("does not reuse a conversation after its soul contents change", async () => {
    const store = new MemoryLeucoStore({ soul: "/SOUL.md" })
    store.instructions.set("/SOUL.md", "one")
    const first = create(store)
    await first.runtime.start()
    await first.runtime.runTextTurn("cli", "first")
    await first.runtime.stop()
    store.instructions.set("/SOUL.md", "two")
    const second = create(store)
    await second.runtime.start()
    await second.runtime.runTextTurn("cli", "second")
    expect(second.codex.resumes).toEqual([])
    expect(second.codex.starts[0]?.developerInstructions).toBe("two")
  })

  it("resumes persisted conversations after restart and separates thread keys", async () => {
    const fixture = create()
    await fixture.runtime.start()
    await fixture.runtime.runTextTurn("slack:C1:T1", "one")
    await fixture.runtime.runTextTurn("slack:C1:T2", "two")
    await fixture.runtime.runTextTurn("slack:C1:T1", "three")
    expect(fixture.codex.starts).toHaveLength(2)
    expect(fixture.codex.turns.map((turn) => turn.threadId)).toEqual([
      "thread-1",
      "thread-2",
      "thread-1",
    ])
    await fixture.runtime.stop()
    const next = create(fixture.store)
    await next.runtime.start()
    await next.runtime.runTextTurn("slack:C1:T2", "continue")
    expect(next.codex.starts).toHaveLength(0)
    expect(next.codex.resumes).toEqual([{ threadId: "thread-2", cwd: "/work" }])
  })

  it("serializes all work for the single companion", async () => {
    const fixture = create()
    fixture.codex.hold = true
    await fixture.runtime.start()
    const first = fixture.runtime.runTextTurn("one", "first")
    const second = fixture.runtime.runTextTurn("two", "second")
    await flush()
    expect(fixture.codex.turns).toHaveLength(1)
    fixture.codex.complete("first reply")
    expect(await first).toBe("first reply")
    await flush()
    expect(fixture.codex.turns).toHaveLength(2)
    fixture.codex.complete("second reply")
    expect(await second).toBe("second reply")
  })

  it("recovers for the next request without replaying a failed turn", async () => {
    const fixture = create()
    await fixture.runtime.start()
    fixture.codex.reply = new Error("process exited")
    expect(await fixture.runtime.runTextTurn("cli", "charge once")).toBeInstanceOf(Error)
    fixture.codex.reply = "recovered"
    expect(await fixture.runtime.runTextTurn("cli", "new request")).toBe("recovered")
    expect(fixture.codex.startCount).toBe(2)
    expect(fixture.codex.turns.map((turn) => turn.text)).toEqual(["charge once", "new request"])
  })

  it("starts a fresh thread for a missing saved conversation", async () => {
    const fixture = create()
    await fixture.runtime.start()
    await fixture.runtime.runTextTurn("cli", "first")
    await fixture.runtime.stop()
    const next = create(fixture.store)
    next.codex.resumeOutcome = "missing"
    await next.runtime.start()
    expect(await next.runtime.runTextTurn("cli", "next")).toBe("done")
    expect(next.codex.starts).toHaveLength(1)
  })

  it("does not replace stored history for an arbitrary resume failure", async () => {
    const fixture = create()
    await fixture.runtime.start()
    await fixture.runtime.runTextTurn("cli", "first")
    await fixture.runtime.stop()
    const next = create(fixture.store)
    next.codex.resumeOutcome = new Error("permission denied")
    await next.runtime.start()
    expect(await next.runtime.runTextTurn("cli", "next")).toBeInstanceOf(Error)
    expect(next.codex.starts).toHaveLength(0)
  })

  it("enforces the idle deadline and remains usable afterward", async () => {
    vi.useFakeTimers()
    const fixture = create(new MemoryLeucoStore({ idleTimeoutMs: 20, turnTimeoutMs: 100 }))
    fixture.codex.hold = true
    await fixture.runtime.start()
    const reply = fixture.runtime.runTextTurn("cli", "stuck")
    await flush()
    await vi.advanceTimersByTimeAsync(21)
    expect(String(await reply)).toContain("idle timeout")
    fixture.codex.hold = false
    expect(await fixture.runtime.runTextTurn("cli", "next")).toBe("done")
  })

  it("enforces a hard deadline while creating a thread and ignores its late result", async () => {
    vi.useFakeTimers()
    const fixture = create(new MemoryLeucoStore({ idleTimeoutMs: 100, turnTimeoutMs: 20 }))
    const late = Promise.withResolvers<{ thread: { id: string } }>()
    fixture.codex.startThread = () => late.promise
    await fixture.runtime.start()
    const reply = fixture.runtime.runTextTurn("cli", "slow start")
    await vi.advanceTimersByTimeAsync(21)
    expect(String(await reply)).toContain("hard deadline")
    late.resolve({ thread: { id: "late" } })
    await flush()
    expect(fixture.codex.turns).toHaveLength(0)
    expect(fixture.store.loadState().threads).toEqual({})
  })

  it("rejects oversized input and settles active and queued work on stop", async () => {
    const fixture = create()
    fixture.codex.hold = true
    await fixture.runtime.start()
    expect(await fixture.runtime.runTextTurn("cli", "x".repeat(256 * 1024 + 1))).toBeInstanceOf(
      Error,
    )
    const first = fixture.runtime.runTextTurn("cli", "active")
    const queued = fixture.runtime.runTextTurn("cli", "queued")
    await flush()
    await fixture.runtime.stop()
    expect(await first).toBeInstanceOf(Error)
    expect(await queued).toBeInstanceOf(Error)
    expect(fixture.codex.turns).toHaveLength(1)
    expect(await fixture.runtime.runTextTurn("cli", "later")).toBeInstanceOf(Error)
    await expect(fixture.runtime.start()).rejects.toThrow("only start once")
  })

  it("closes Codex when the requested soul cannot be read", async () => {
    const fixture = create(new MemoryLeucoStore(), new MemoryCodexClient(), "/missing")
    await expect(fixture.runtime.start()).rejects.toThrow("not found")
    expect(fixture.codex.isRunning()).toBe(false)
  })

  it("closes an unsuccessfully started child", async () => {
    const fixture = create()
    fixture.codex.startError = new Error("initialize failed")
    await expect(fixture.runtime.start()).rejects.toThrow("initialize failed")
    expect(fixture.codex.stopCount).toBe(1)
  })
  it("stops connections that finish starting after shutdown", async () => {
    const starting = Promise.withResolvers<void>()
    const connection: Connector = {
      name: "slack",
      start: vi.fn(() => starting.promise),
      stop: vi.fn(async () => {}),
      getIdentity: () => ({ name: "slack", type: "slack", botUserId: null }),
    }
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex: new MemoryCodexClient(),
      connections: [connection],
      env: {},
    })
    active.push(runtime)
    const started = runtime.start()
    await flush()
    expect(connection.start).toHaveBeenCalledOnce()
    await runtime.stop()
    starting.resolve()
    await expect(started).rejects.toThrow("stopped during startup")
    expect(connection.stop).toHaveBeenCalledTimes(2)
  })

  it("bounds the waiting queue and settles every queued request on stop", async () => {
    const fixture = create()
    fixture.codex.hold = true
    await fixture.runtime.start()
    const running = fixture.runtime.runTextTurn("cli", "running")
    await flush()
    const waiting = Array.from({ length: 64 }, (_, index) =>
      fixture.runtime.runTextTurn(`queue-${index}`, "pending"),
    )
    expect(String(await fixture.runtime.runTextTurn("overflow", "pending"))).toContain(
      "queue is full",
    )
    await fixture.runtime.stop()
    expect(
      (await Promise.all([running, ...waiting])).every((reply) => reply instanceof Error),
    ).toBe(true)
  })
})
