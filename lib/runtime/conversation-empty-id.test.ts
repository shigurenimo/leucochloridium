import { expect, it, vi } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { stateSchema } from "@/config/config-schema"
import { threadStartResultSchema } from "@/engine/codex/codex-schemas"

it.each(["", " ", "\t\n"])("rejects blank saved and returned conversation IDs: %j", (id) => {
  expect(threadStartResultSchema.safeParse({ thread: { id } }).success).toBe(false)
  expect(stateSchema.safeParse({ threads: { shared: { id, context: "saved" } } }).success).toBe(
    false,
  )
})

it.each(["", " ", "\t\n"])(
  "does not persist or dispatch a blank newly created ID: %j",
  async (id) => {
    const store = new MemoryLeucoStore()
    const codex = new MemoryCodexClient()
    vi.spyOn(codex, "startThread").mockResolvedValueOnce({ thread: { id } })
    const runtime = LeucoRuntime.build({ store, codex, connections: [], env: {} })
    try {
      await runtime.start()
      expect(await runtime.runTextTurn("shared", "must not dispatch")).toMatchObject({
        code: "CODEX_THREAD_INVALID",
      })
      expect(store.loadState().threads.shared).toBeUndefined()
      expect(codex.turns).toEqual([])
      expect(await runtime.runTextTurn("shared", "after valid creation")).toBe("done")
      expect(codex.turns.map((turn) => turn.text)).toEqual(["after valid creation"])
      expect(store.loadState().threads.shared?.id).toBe("thread-1")
    } finally {
      await runtime.stop()
    }
  },
)

it("preserves valid opaque IDs without trimming or normalizing them", () => {
  const id = " opaque-thread-id "
  expect(threadStartResultSchema.parse({ thread: { id } }).thread.id).toBe(id)
  expect(
    stateSchema.parse({ threads: { shared: { id, context: "saved" } } }).threads.shared?.id,
  ).toBe(id)
})

it.each(["", " \t"])("rejects a blank saved ID from an injected store: %j", async (id) => {
  const store = new MemoryLeucoStore()
  const codex = new MemoryCodexClient()
  const runtime = LeucoRuntime.build({ store, codex, connections: [], env: {} })
  try {
    await runtime.start()
    await runtime.runTextTurn("shared", "first")
    const saved = store.loadState()
    const mapping = saved.threads.shared
    if (mapping === undefined) throw new Error("conversation missing")
    await codex.stop()
    vi.spyOn(store, "loadState").mockReturnValueOnce({
      ...saved,
      threads: { shared: { ...mapping, id } },
    })
    expect(await runtime.runTextTurn("shared", "must not resume")).toMatchObject({
      code: "CODEX_THREAD_INVALID",
    })
    expect(codex.resumes).toEqual([])
    expect(codex.turns.map((turn) => turn.text)).toEqual(["first"])
    expect(store.loadState()).toEqual(saved)
  } finally {
    await runtime.stop()
  }
})
