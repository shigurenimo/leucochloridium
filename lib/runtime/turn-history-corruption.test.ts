import { afterEach, expect, it } from "vitest"
import type { LeucoState } from "@/config/config-schema"
import { CodexTurnError } from "@/engine/codex/codex-turn-error"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"

const corruption = (secret: string) =>
  new CodexTurnError(
    "turn-corrupt",
    "failed",
    `[ObjectParam] [input[381].arguments.bad] invalid_request_error: property name is too long ${secret}`,
  )

class FailingStateStore extends MemoryLeucoStore {
  readonly failure = { isEnabled: false }

  override updateState(transform: (state: LeucoState) => LeucoState): void {
    if (this.failure.isEnabled) throw new Error("state write failed")
    super.updateState(transform)
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function create(store = new MemoryLeucoStore()) {
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
  cleanups.push(async () => {
    await runtime.stop()
    events.close()
  })
  return { runtime, codex, events, store }
}

it("replaces only the mapping whose turn Codex rejected for invalid history", async () => {
  const fixture = create()
  const secret = "private-turn-history-secret"
  fixture.events.addRedactionSecrets([secret])
  await fixture.runtime.start()
  await fixture.runtime.runTextTurn("other", "keep")
  await fixture.runtime.runTextTurn("shared", "first")
  const before = fixture.store.loadState().threads
  fixture.codex.reply = corruption(secret)

  const failed = await fixture.runtime.runTextTurn("shared", "charge once", "corrupt-request")

  expect(failed).toBeInstanceOf(Error)
  if (!(failed instanceof Error)) throw new Error("Expected a turn failure")
  expect(failed.message).toContain("conversation was reset")
  expect(failed.message).toContain("not retried")
  expect(failed.message).not.toContain(secret)
  expect(Object.hasOwn(fixture.store.loadState().threads, "shared")).toBe(false)
  expect(fixture.store.loadState().threads.other).toEqual(before.other)
  const requestEvents = fixture.events
    .query({ requestId: "corrupt-request" })
    .map((entry) => entry.event)
  const warnings = requestEvents.filter((event) => event.type === "log" && event.level === "warn")
  expect(warnings).toHaveLength(1)
  const warning = warnings[0]
  if (warning?.type !== "log") throw new Error("Missing history reset diagnostic")
  expect(warning.line).toContain(before.shared!.id)
  expect(warning.causes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "CodexTurnError",
        message: expect.stringContaining("[redacted]"),
      }),
    ]),
  )
  const failure = requestEvents.find((event) => event.type === "turn.error")
  if (failure?.type !== "turn.error") throw new Error("Missing turn failure")
  expect(failure.causes).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "CODEX_HISTORY_RESET" })]),
  )
  expect(JSON.stringify(requestEvents)).not.toContain(secret)

  fixture.codex.reply = "fresh"
  expect(await fixture.runtime.runTextTurn("shared", "next")).toBe("fresh")
  const after = fixture.store.loadState().threads.shared
  expect(after?.id).not.toBe(before.shared!.id)
  expect(fixture.codex.resumes.map((resume) => resume.threadId)).not.toContain(before.shared!.id)
  expect(fixture.codex.turns.map((turn) => turn.text)).toEqual([
    "keep",
    "first",
    "charge once",
    "next",
  ])
})

it.each([
  ["a local error quoting the same text", new Error(corruption("").message)],
  ["an interrupted turn", new CodexTurnError("turn-1", "interrupted", corruption("").turnMessage)],
  ["another failed turn", new CodexTurnError("turn-1", "failed", "usage limit reached")],
])("keeps the saved mapping after %s", async (_name, reply) => {
  const fixture = create()
  await fixture.runtime.start()
  await fixture.runtime.runTextTurn("shared", "first")
  const saved = fixture.store.loadState().threads.shared
  fixture.codex.reply = reply

  expect(await fixture.runtime.runTextTurn("shared", "charge once")).toBe(reply)

  expect(fixture.store.loadState().threads.shared).toEqual(saved)
  fixture.codex.reply = "resumed"
  expect(await fixture.runtime.runTextTurn("shared", "next")).toBe("resumed")
  expect(fixture.codex.resumes.map((resume) => resume.threadId)).toEqual([saved!.id])
  expect(fixture.codex.starts).toHaveLength(1)
})

it("reports both causes when the rejected mapping cannot be removed", async () => {
  const store = new FailingStateStore()
  const fixture = create(store)
  await fixture.runtime.start()
  await fixture.runtime.runTextTurn("shared", "first")
  const saved = store.loadState().threads.shared
  const rejection = corruption("")
  fixture.codex.reply = rejection
  store.failure.isEnabled = true

  const failed = await fixture.runtime.runTextTurn("shared", "charge once", "write-failure")

  expect(failed).toBeInstanceOf(AggregateError)
  if (!(failed instanceof AggregateError)) throw new Error("Expected both failures")
  expect(failed.errors[0]).toBe(rejection)
  expect(failed.errors[1]).toEqual(new Error("state write failed"))
  expect(store.loadState().threads.shared).toEqual(saved)
  expect(
    fixture.events
      .query({ requestId: "write-failure" })
      .some((entry) => entry.event.type === "log" && entry.event.level === "error"),
  ).toBe(true)
  expect(fixture.codex.turns.map((turn) => turn.text)).toEqual(["first", "charge once"])
})
