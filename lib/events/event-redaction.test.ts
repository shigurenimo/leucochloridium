import { afterEach, expect, it, vi } from "vitest"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { MemoryEventLog } from "@/event-log/memory-event-log"
import { MemoryDiagnosticOutput } from "@/memory-diagnostic-output"

afterEach(() => vi.restoreAllMocks())

it.each(['synthetic"private\\\nvalue', '"', "\\"])(
  "masks an escaped secret without losing or corrupting its event (%j)",
  (secret) => {
    const log = new LeucoEventLog({ diagnosticOutput: new MemoryDiagnosticOutput() })
    log.addRedactionSecrets([secret])
    log.log("info", `before ${secret} after`, "masked-request")
    expect(log.getHealth()).toMatchObject({ failedWrites: 0, successfulWrites: 1 })
    expect(log.query({ requestId: "masked-request" })[0]?.event).toMatchObject({
      line: "before [redacted] after",
    })
    log.close()
  },
)
it("masks nested payloads and property names before sending a failed write to the fallback", () => {
  const secret = 'synthetic"private\\\nvalue'
  const fallback = vi.fn()
  const log = new LeucoEventLog({
    onFallback: fallback,
    diagnosticOutput: new MemoryDiagnosticOutput(),
  })
  log.addRedactionSecrets([secret])
  vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementationOnce(() => {
    throw new Error("injected storage failure")
  })
  log.append({
    ts: 1,
    type: "codex.notification",
    runtime: "leuco",
    method: "probe",
    params: { [secret]: [{ value: secret }] },
  })
  expect(fallback).toHaveBeenCalledWith(
    expect.objectContaining({ params: { "[redacted]": [{ value: "[redacted]" }] } }),
  )
  expect(log.getHealth().failedWrites).toBe(1)
  log.close()
})
it("captures a JSON snapshot even when no secret matched", () => {
  const log = new LeucoEventLog()
  const params = { nested: { value: "original" } }
  log.append({ ts: 1, type: "codex.notification", runtime: "leuco", method: "probe", params })
  params.nested.value = "later mutation"
  expect(log.query()[0]?.event).toMatchObject({ params: { nested: { value: "original" } } })
  log.close()
})

it("masks a complete escaped value before event-line clipping can retain a fragment", () => {
  const secret = 'synthetic"private\\\nvalue'
  const log = new LeucoEventLog()
  log.addRedactionSecrets([secret])
  log.log("warn", `${"x".repeat(15980)}${secret}${"z".repeat(200)}`)
  const event = log.query()[0]?.event
  expect(event?.type).toBe("log")
  if (event?.type === "log") {
    expect(event.line).toContain("[redacted]")
    expect(event.line).not.toContain("synthetic")
    expect(event.line).toContain("[truncated]")
  }
  log.close()
})

it("applies newly registered secrets when reading older memory history", () => {
  const secret = 'synthetic"late-secret'
  const log = new LeucoEventLog()
  try {
    log.log("warn", `before ${secret} after`)
    const earlier = log.query()[0]
    log.addRedactionSecrets([secret])
    expect(log.query()[0]?.event).toMatchObject({ line: "before [redacted] after" })
    expect(earlier?.event).toMatchObject({ line: `before ${secret} after` })
  } finally {
    log.close()
  }
})
it("detaches query records and nested payloads from the retained memory history", () => {
  const log = new LeucoEventLog()
  try {
    log.append({
      ts: 1,
      type: "codex.notification",
      runtime: "leuco",
      method: "probe",
      params: { nested: { value: "original" } },
    })
    const record = log.query()[0]!
    record.seq = 999
    if (
      record.event.type !== "codex.notification" ||
      record.event.params === null ||
      typeof record.event.params !== "object"
    )
      throw new Error("Expected notification object")
    Reflect.set(record.event.params, "nested", { value: "caller mutation" })
    expect(log.query()[0]).toMatchObject({
      seq: 1,
      event: { params: { nested: { value: "original" } } },
    })
  } finally {
    log.close()
  }
})
