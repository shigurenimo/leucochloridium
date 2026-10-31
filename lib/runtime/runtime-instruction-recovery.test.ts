import { afterEach, expect, it, vi } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"

const active: LeucoRuntime[] = []
afterEach(async () => {
  for (const runtime of active.splice(0)) await runtime.stop()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each(["changed", "with-soul", "unchanged", "config-error"])(
  "refreshes native instructions before reusing conversations after reconnect: %s",
  async (scenario) => {
    const codex = new MemoryCodexClient()
    codex.nativeInstructions = "native old"
    const store = new MemoryLeucoStore()
    store.instructions.set("/SOUL.md", "startup soul")
    const runtime = LeucoRuntime.build({
      cwd: "/work",
      env: {},
      store,
      codex,
      connections: [],
      ...(scenario === "with-soul" ? { soul: "/SOUL.md" } : {}),
    })
    active.push(runtime)
    await runtime.start()
    await runtime.runTextTurn("shared", "first")
    await codex.stop()
    codex.nativeInstructions = scenario === "unchanged" ? "native old" : "native new"
    store.instructions.set("/SOUL.md", "edited without restarting Leuco")
    if (scenario === "config-error") {
      vi.spyOn(codex, "getDeveloperInstructions").mockRejectedValueOnce(
        new Error("config unavailable"),
      )
      expect(await runtime.runTextTurn("shared", "must not dispatch")).toBeInstanceOf(Error)
      expect(codex.turns).toHaveLength(1)
      expect(codex.resumes).toHaveLength(0)
    }
    expect(await runtime.runTextTurn("shared", "second")).toBe("done")
    expect(codex.turns.map((turn) => turn.text)).toEqual(["first", "second"])
    expect(codex.starts).toHaveLength(scenario === "unchanged" ? 1 : 2)
    expect(codex.resumes).toHaveLength(scenario === "unchanged" ? 1 : 0)
    if (scenario === "with-soul")
      expect(codex.starts[1]?.developerInstructions).toBe("native new\n\nstartup soul")
  },
)

it("does not let a cancelled instruction read replace the next connection's context", async () => {
  vi.useFakeTimers()
  const codex = new MemoryCodexClient()
  codex.nativeInstructions = "native old"
  const runtime = LeucoRuntime.build({
    env: {},
    store: new MemoryLeucoStore({ turnTimeoutMs: 20, idleTimeoutMs: 1000 }),
    codex,
    connections: [],
  })
  active.push(runtime)
  await runtime.start()
  await runtime.runTextTurn("shared", "first")
  await codex.stop()
  const obsolete = Promise.withResolvers<string>()
  vi.spyOn(codex, "getDeveloperInstructions").mockReturnValueOnce(obsolete.promise)
  try {
    const pending = runtime.runTextTurn("shared", "times out")
    await vi.advanceTimersByTimeAsync(21)
    expect(await pending).toBeInstanceOf(Error)
    codex.nativeInstructions = "native current"
    expect(await runtime.runTextTurn("shared", "after recovery")).toBe("done")
    obsolete.resolve("obsolete instructions")
    for (const _ of Array.from({ length: 30 })) await Promise.resolve()
    expect(await runtime.runTextTurn("shared", "still current")).toBe("done")
    expect(codex.starts).toHaveLength(2)
    expect(codex.turns.map((turn) => turn.text)).toEqual([
      "first",
      "after recovery",
      "still current",
    ])
  } finally {
    obsolete.resolve("obsolete instructions")
  }
})
