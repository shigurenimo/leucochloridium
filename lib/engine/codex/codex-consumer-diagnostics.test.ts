import { afterEach, expect, it, vi } from "vitest"
import { CodexConsumerDiagnostics } from "@/engine/codex/codex-consumer-diagnostics"
import { MemoryDiagnosticOutput } from "@/memory-diagnostic-output"
import { redactPublicText } from "@/secrets/redact-public-text"

afterEach(() => vi.useRealTimers())

it.each(["sync", "async"])(
  "retains masked causes when diagnostic output fails %s and later recovers",
  async (mode) => {
    const secret = "private-consumer-credential"
    const primary = Object.assign(new Error(`${"p".repeat(3988)}${secret}tail`), {
      code: "ECONSUMER",
    })
    const reporting = Object.assign(new Error(`output failed ${secret}`), { code: "EPIPE" })
    const output = new MemoryDiagnosticOutput()
    if (mode === "async") output.failure = reporting
    else
      vi.spyOn(output, "write").mockImplementationOnce(() => {
        throw reporting
      })
    const diagnostics = new CodexConsumerDiagnostics({
      output,
      redactLogText: (text) => redactPublicText(text, [secret]),
    })
    diagnostics.report({ kind: "log", error: primary })
    await diagnostics.drain()
    const health = diagnostics.getHealth()
    expect(health).toMatchObject({ healthy: false, pending: 0 })
    expect(health.lastFailure?.causes.map((cause) => cause.code)).toEqual(
      expect.arrayContaining(["ECONSUMER", "EPIPE"]),
    )
    expect(JSON.stringify(health)).not.toContain("private-")
    health.lastFailure!.causes[0]!.message = "caller mutation"
    expect(diagnostics.getHealth().lastFailure?.causes[0]?.message).not.toBe("caller mutation")
    output.failure = null
    diagnostics.report({ kind: "log", error: new Error("later diagnostic") })
    await diagnostics.drain()
    expect(diagnostics.getHealth().healthy).toBe(true)
    expect(diagnostics.getHealth().lastFailure).not.toBeNull()
  },
)

it("bounds stalled output and refuses more than 64 pending diagnostic writes", async () => {
  vi.useFakeTimers()
  const output = new MemoryDiagnosticOutput()
  const write = vi.spyOn(output, "write").mockImplementation(async () => new Promise(() => {}))
  const diagnostics = new CodexConsumerDiagnostics({ output })
  for (const _ of Array.from({ length: 65 }))
    diagnostics.report({ kind: "notification", error: new Error("observer failed") })
  expect(write).toHaveBeenCalledTimes(64)
  expect(diagnostics.getHealth()).toMatchObject({ healthy: false, pending: 64 })
  await vi.advanceTimersByTimeAsync(1000)
  await diagnostics.drain()
  expect(diagnostics.getHealth()).toMatchObject({ healthy: false, pending: 0 })
  expect(JSON.stringify(diagnostics.getHealth())).toContain("timed out after 1000ms")
  expect(vi.getTimerCount()).toBe(0)
})

it("does not let an older successful write clear a newer failure", async () => {
  vi.useFakeTimers()
  const first = Promise.withResolvers<void>()
  const output = new MemoryDiagnosticOutput()
  vi.spyOn(output, "write")
    .mockImplementationOnce(() => first.promise)
    .mockRejectedValueOnce(Object.assign(new Error("newer write failed"), { code: "EIO" }))
  const diagnostics = new CodexConsumerDiagnostics({ output })
  diagnostics.report({ kind: "log", error: new Error("first callback failed") })
  diagnostics.report({ kind: "notification", error: new Error("second callback failed") })
  await vi.advanceTimersByTimeAsync(0)
  expect(diagnostics.getHealth().healthy).toBe(false)
  first.resolve()
  await diagnostics.drain()
  expect(diagnostics.getHealth().healthy).toBe(false)
})

it("captures bounded causes before the caller can mutate a pending diagnostic", async () => {
  const delivery = Promise.withResolvers<void>()
  const output = new MemoryDiagnosticOutput()
  vi.spyOn(output, "write").mockImplementationOnce(() => delivery.promise)
  const diagnostics = new CodexConsumerDiagnostics({ output })
  const primary = new Error("original callback failure")
  diagnostics.report({ kind: "log", error: primary })
  primary.message = "later caller mutation"
  delivery.reject(Object.assign(new Error("pipe failed"), { code: "EPIPE" }))
  await diagnostics.drain()
  const snapshot = JSON.stringify(diagnostics.getHealth())
  expect(snapshot).toContain("original callback failure")
  expect(snapshot).not.toContain("later caller mutation")
})
