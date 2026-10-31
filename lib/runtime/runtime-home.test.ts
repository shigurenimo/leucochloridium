import { expect, it, vi } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"

it.each([false, true])(
  "rejects an empty home before reading settings (explicit: %s)",
  (explicit) => {
    const store = new MemoryLeucoStore()
    const read = vi.spyOn(store, "loadSettings")
    const events = new LeucoEventLog()
    try {
      expect(() =>
        LeucoRuntime.build({
          ...(explicit ? { home: "" } : {}),
          env: { LEUCO_HOME: explicit ? "/configured-home" : "" },
          store,
          codex: new MemoryCodexClient(),
          eventLog: events,
        }),
      ).toThrow("Leuco home must not be empty")
      expect(read).not.toHaveBeenCalled()
    } finally {
      events.close()
    }
  },
)

it("uses an explicit valid home ahead of an empty environment override", async () => {
  const events = new LeucoEventLog()
  const runtime = LeucoRuntime.build({
    home: "/explicit-home",
    env: { LEUCO_HOME: "" },
    store: new MemoryLeucoStore(),
    codex: new MemoryCodexClient(),
    eventLog: events,
  })
  try {
    expect(runtime.home).toBe("/explicit-home")
  } finally {
    await runtime.stop()
    events.close()
  }
})
