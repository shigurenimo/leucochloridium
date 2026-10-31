import { expect, it } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"

for (const field of ["message", "stack", "name", "code"]) {
  it.each(["root", "nested"])(
    `masks a complete secret before clipping the ${field} of a %s turn failure`,
    async (placement) => {
      const events = new LeucoEventLog()
      const secret = `known-secret-boundary-${"s".repeat(256)}`
      events.addRedactionSecrets([secret])
      const prefix = field === "message" ? 3960 : field === "stack" ? 7960 : 60
      const failure = Object.assign(new Error("backend failed"), {
        [field]: `${"p".repeat(prefix)}${secret} tail`,
      })
      const reply = placement === "root" ? failure : new Error("outer failure", { cause: failure })
      const codex = new MemoryCodexClient()
      codex.reply = reply
      const runtime = LeucoRuntime.build({
        cwd: "/work",
        store: new MemoryLeucoStore(),
        codex,
        eventLog: events,
        connections: [],
        env: {},
      })
      try {
        await runtime.start()
        expect(await runtime.runTextTurn("shared", "request", "redacted-failure")).toBe(reply)
        const errors = events.query({ requestId: "redacted-failure", type: "turn.error" })
        expect(errors).toHaveLength(1)
        const serialized = JSON.stringify(errors)
        expect(serialized).not.toContain("known-secret-boundary")
        expect(serialized).toContain("[redacted]")
        const event = errors[0]!.event
        if (event.type !== "turn.error") throw new Error("Missing turn failure")
        expect(event.causes?.length).toBe(placement === "root" ? 1 : 2)
        for (const cause of event.causes ?? []) {
          expect(cause.message.length).toBeLessThanOrEqual(4000)
          expect(cause.stack?.length ?? 0).toBeLessThanOrEqual(8000)
          expect(cause.name.length).toBeLessThanOrEqual(100)
          expect(cause.code?.length ?? 0).toBeLessThanOrEqual(100)
        }
        codex.reply = "recovered"
        expect(await runtime.runTextTurn("shared", "explicit next request")).toBe("recovered")
      } finally {
        await runtime.stop()
        events.close()
      }
    },
  )
}

it("bounds stored turn failure text and keeps it consistent with runtime status", async () => {
  const events = new LeucoEventLog()
  const codex = new MemoryCodexClient()
  const failure = Object.assign(new Error(`large failure ${"x".repeat(100000)}`), {
    code: "BACKEND_FAILED",
  })
  codex.reply = failure
  const runtime = LeucoRuntime.build({
    cwd: "/work",
    store: new MemoryLeucoStore(),
    codex,
    eventLog: events,
    connections: [],
    env: {},
  })
  try {
    await runtime.start()
    expect(await runtime.runTextTurn("shared", "request", "large-failure")).toBe(failure)
    const event = events.query({ requestId: "large-failure", type: "turn.error" })[0]?.event
    if (event?.type !== "turn.error") throw new Error("Missing turn failure")
    expect(event.error.length).toBeLessThanOrEqual(4000)
    expect(event.error).toBe(runtime.getStatus().lastFailure?.message)
    expect(event.error).toBe(event.causes?.[0]?.message)
    expect(event.error).toMatch(/^large failure /)
    expect(event.error).toMatch(/ \[truncated\]$/)
    expect(event.causes?.[0]?.code).toBe("BACKEND_FAILED")
  } finally {
    await runtime.stop()
    events.close()
  }
})
