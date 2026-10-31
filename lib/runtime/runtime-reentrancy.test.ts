import { afterEach, expect, it, vi } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { MemoryEventLog } from "@/event-log/memory-event-log"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { LeucoEvent } from "@/events/leuco-event-types"

afterEach(() => vi.restoreAllMocks())

function fixture(onEvent: (event: LeucoEvent) => void) {
  vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementation(() => {
    throw new Error("synthetic event persistence failure")
  })
  const eventLog = new LeucoEventLog({ diagnosticOutput: null, onFallback: onEvent })
  const codex = new MemoryCodexClient()
  codex.hold = true
  const runtime = LeucoRuntime.build({
    env: {},
    store: new MemoryLeucoStore(),
    codex,
    eventLog,
    connections: [],
  })
  return { runtime, codex, eventLog }
}

async function flush() {
  for (const index of Array.from({ length: 20 }).keys()) {
    void index
    await Promise.resolve()
  }
}

it("keeps callback-enqueued work serial during turn startup", async () => {
  const nested: { reply: Promise<string | Error> | null } = { reply: null }
  const test = fixture((event) => {
    if (event.type === "turn.start" && event.requestId === "first")
      nested.reply = test.runtime.runTextTurn("second", "second", "second")
  })
  try {
    await test.runtime.start()
    const first = test.runtime.runTextTurn("first", "first", "first")
    await flush()
    expect(test.codex.turns).toHaveLength(1)
    expect(test.runtime.getStatus().queue.waiting).toBe(1)
    test.codex.complete("first done")
    expect(await first).toBe("first done")
    await flush()
    expect(test.codex.turns).toHaveLength(2)
    test.codex.complete("second done")
    expect(await nested.reply).toBe("second done")
  } finally {
    await test.runtime.stop()
    test.eventLog.close()
  }
})

it("keeps queue bytes empty when a diagnostic callback stops queued work", async () => {
  const stopped: { promise: Promise<void> | null } = { promise: null }
  const test = fixture((event) => {
    if (event.type === "turn.queued") stopped.promise = test.runtime.stop()
  })
  try {
    await test.runtime.start()
    expect(await test.runtime.runTextTurn("first", "first")).toBeInstanceOf(Error)
    await stopped.promise
    expect(test.runtime.getStatus().queue).toMatchObject({ waiting: 0, bytes: 0 })
    expect(test.codex.turns).toHaveLength(0)
  } finally {
    await test.runtime.stop()
    test.eventLog.close()
  }
})

it("closes resources once when cancellation diagnostics request stop again", async () => {
  const test = fixture((event) => {
    if (event.type === "turn.error") void test.runtime.stop()
  })
  try {
    await test.runtime.start()
    const first = test.runtime.runTextTurn("first", "first")
    await flush()
    const queued = test.runtime.runTextTurn("second", "second")
    await test.runtime.stop()
    expect(await first).toBeInstanceOf(Error)
    expect(await queued).toBeInstanceOf(Error)
    expect(test.codex.stopCount).toBe(1)
  } finally {
    await test.runtime.stop()
    test.eventLog.close()
  }
})

it.each(["turn.start", "reconnect"])(
  "does not reconnect after a %s diagnostic callback stops the runtime",
  async (phase) => {
    const stopped: { promise: Promise<void> | null } = { promise: null }
    const test = fixture((event) => {
      if (
        (phase === "turn.start" && event.type === "turn.start") ||
        (phase === "reconnect" && event.type === "log" && event.line.startsWith("Reconnecting"))
      )
        stopped.promise = test.runtime.stop()
    })
    try {
      await test.runtime.start()
      await test.codex.stop()
      expect(await test.runtime.runTextTurn("first", "first")).toBeInstanceOf(Error)
      await stopped.promise
      expect(test.codex.startCount).toBe(1)
      expect(test.codex.turns).toHaveLength(0)
    } finally {
      await test.runtime.stop()
      test.eventLog.close()
    }
  },
)

it("does not create a replacement thread after recovery diagnostics stop the runtime", async () => {
  const stopped: { promise: Promise<void> | null } = { promise: null }
  const test = fixture((event) => {
    if (event.type === "log" && event.line.startsWith("Stored thread "))
      stopped.promise = test.runtime.stop()
  })
  try {
    test.codex.hold = false
    await test.runtime.start()
    expect(await test.runtime.runTextTurn("first", "first")).toBe("done")
    await test.codex.stop()
    test.codex.resumeOutcome = "missing"
    expect(await test.runtime.runTextTurn("first", "second")).toBeInstanceOf(Error)
    await stopped.promise
    expect(test.codex.resumes).toHaveLength(1)
    expect(test.codex.starts).toHaveLength(1)
    expect(test.codex.turns).toHaveLength(1)
  } finally {
    await test.runtime.stop()
    test.eventLog.close()
  }
})

it("rejects startup when the started diagnostic callback stops the runtime", async () => {
  const stopped: { promise: Promise<void> | null } = { promise: null }
  const test = fixture((event) => {
    if (event.type === "runtime.started") stopped.promise = test.runtime.stop()
  })
  try {
    await expect(test.runtime.start()).rejects.toThrow("Runtime stopped during startup")
    await stopped.promise
    expect(test.runtime.getStatus().lifecycle).toBe("stopped")
    expect(test.codex.isRunning()).toBe(false)
    expect(test.codex.stopCount).toBe(1)
  } finally {
    await test.runtime.stop()
    test.eventLog.close()
  }
})
