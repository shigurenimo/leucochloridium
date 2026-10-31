import { CodexRpcError } from "@/engine/codex/codex-rpc-error"
import { expect, it } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"

it.each(["missing", "corrupt"])(
  "records the reason and original cause when replacing %s history",
  async (mode) => {
    const store = new MemoryLeucoStore()
    const codex = new MemoryCodexClient()
    const events = new LeucoEventLog()
    const secret = "private-history-secret"
    events.addRedactionSecrets([secret])
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
      codex.resumeOutcome =
        mode === "missing"
          ? "missing"
          : new CodexRpcError(-32600, `invalid_request_error: input[7].arguments ${secret}`)
      expect(await runtime.runTextTurn("shared", "next", "recovery-request")).toBe("done")
      const warnings = events
        .query({ requestId: "recovery-request" })
        .map((entry) => entry.event)
        .filter((event) => event.type === "log" && event.level === "warn")
      expect(warnings).toHaveLength(1)
      const warning = warnings[0]
      expect(warning?.type).toBe("log")
      if (warning?.type !== "log") throw new Error("Missing recovery diagnostic")
      expect(warning.line).toContain(saved!.id)
      expect(warning.line).toContain(mode === "missing" ? "missing history" : "invalid history")
      if (mode === "corrupt") {
        expect(warning.causes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "-32600",
              message: expect.stringContaining("[redacted]"),
            }),
          ]),
        )
      } else expect(warning.causes).toBeUndefined()
      expect(JSON.stringify(warnings)).not.toContain(secret)
      expect(store.loadState().threads.shared?.id).not.toBe(saved!.id)
      expect(codex.turns.map((turn) => turn.text)).toEqual(["first", "next"])
    } finally {
      await runtime.stop()
      events.close()
    }
  },
)
