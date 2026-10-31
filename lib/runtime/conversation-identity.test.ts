import { expect, it, vi } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"

it.each(["unexpected-conversation", ""])(
  "does not dispatch to a mismatched resumed conversation: %j",
  async (returnedId) => {
    const store = new MemoryLeucoStore()
    const codex = new MemoryCodexClient()
    const events = new LeucoEventLog()
    const runtime = LeucoRuntime.build({
      cwd: "/work",
      store,
      codex,
      eventLog: events,
      connections: [],
      env: {},
    })
    try {
      await runtime.start()
      await runtime.runTextTurn("shared", "first")
      const saved = store.loadState().threads.shared
      await codex.stop()
      const resume = vi.spyOn(codex, "resumeThread")
      resume.mockResolvedValueOnce({ thread: { id: returnedId } })
      expect(await runtime.runTextTurn("shared", "must not dispatch", "mismatch")).toMatchObject({
        code: "CODEX_THREAD_MISMATCH",
      })
      expect(codex.turns.map((turn) => turn.text)).toEqual(["first"])
      expect(store.loadState().threads.shared).toEqual(saved)
      expect(codex.starts).toHaveLength(1)
      expect(
        events
          .query({ requestId: "mismatch" })
          .some(
            (entry) =>
              entry.event.type === "turn.error" &&
              entry.event.causes?.some((cause) => cause.code === "CODEX_THREAD_MISMATCH"),
          ),
      ).toBe(true)
      expect(await runtime.runTextTurn("shared", "after backend recovery")).toBe("done")
      expect(resume).toHaveBeenLastCalledWith({ threadId: saved?.id, cwd: "/work" })
      expect(codex.turns.map((turn) => turn.text)).toEqual(["first", "after backend recovery"])
      expect(store.loadState().threads.shared).toEqual(saved)
      expect(codex.starts).toHaveLength(1)
    } finally {
      await runtime.stop()
      events.close()
    }
  },
)
