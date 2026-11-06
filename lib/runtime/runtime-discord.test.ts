import { afterEach, describe, expect, it, vi } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { executeDiscordCommand } from "@/actions/discord/execute-discord-command"
import { errorDetails } from "@/error-details"

vi.mock("@/actions/discord/execute-discord-command", () => ({
  executeDiscordCommand: vi.fn(async () => ({ id: "1" })),
}))
const active: LeucoRuntime[] = []
afterEach(async () => {
  for (const runtime of active.splice(0)) await runtime.stop()
  vi.clearAllMocks()
})
const reference = "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d"
const secret = "fake-discord-token.secret.signature"
const command = { words: ["discord", "call", "GET", "/users/@me"], flags: {} }
function fixture() {
  const store = new MemoryLeucoStore({ discord: { credential: reference, messageContent: true } })
  const credentials = new MemoryCredentialStore()
  const codex = new MemoryCodexClient()
  const eventLog = new LeucoEventLog()
  const runtime = LeucoRuntime.build({
    store,
    credentials,
    codex,
    eventLog,
    connections: [],
    env: {},
  })
  active.push(runtime)
  return { runtime, credentials, codex, eventLog }
}

describe("Discord runtime credentials", () => {
  it("loads the token once, redacts responses/logs and keeps it out of Codex", async () => {
    const test = fixture()
    await test.credentials.set(reference, JSON.stringify({ botToken: secret }))
    await test.runtime.start()
    await test.credentials.set(
      reference,
      JSON.stringify({ botToken: "changed-discord-token.secret.signature" }),
    )
    vi.mocked(executeDiscordCommand).mockResolvedValueOnce({ debug: secret })
    expect(JSON.stringify(await test.runtime.runDiscordCommand(command))).not.toContain(secret)
    await test.runtime.runDiscordCommand(command)
    expect(test.credentials.reads).toEqual([reference])
    expect(executeDiscordCommand).toHaveBeenLastCalledWith({
      parsed: command,
      botToken: secret,
      signal: expect.any(AbortSignal),
    })
    test.eventLog.log("info", secret)
    expect(JSON.stringify(test.eventLog.query())).not.toContain(secret)
    await test.runtime.runTextTurn("cli", "hello")
    expect(JSON.stringify([test.codex.starts, test.codex.turns])).not.toContain(secret)
    await test.runtime.stop()
    await expect(test.runtime.runDiscordCommand(command)).rejects.toThrow("not running")
  })
  it("fails before starting Codex when the Discord credential is absent", async () => {
    const test = fixture()
    await expect(test.runtime.start()).rejects.toThrow("Discord credentials are missing or invalid")
    expect(test.codex.startCount).toBe(0)
  })
  it("does not return an API response or restore credentials after shutdown", async () => {
    const test = fixture()
    await test.credentials.set(reference, JSON.stringify({ botToken: secret }))
    await test.runtime.start()
    const pending = Promise.withResolvers<unknown>()
    vi.mocked(executeDiscordCommand).mockImplementationOnce(() => pending.promise)
    const operation = test.runtime.runDiscordCommand(command)
    const rejected = expect(operation).rejects.toThrow("Discord operation cancelled")
    const stopping = test.runtime.stop()
    pending.resolve({ debug: secret })
    await stopping
    await rejected
  })
})

describe("Discord runtime cancellation", () => {
  async function startedFixture() {
    const test = fixture()
    await test.credentials.set(reference, JSON.stringify({ botToken: secret }))
    await test.runtime.start()
    return test
  }
  function abortableCommand(settleDelayMs = 0) {
    const seen: AbortSignal[] = []
    vi.mocked(executeDiscordCommand).mockImplementationOnce(
      async (props) =>
        new Promise((_resolve, reject) => {
          seen.push(props.signal)
          props.signal.addEventListener(
            "abort",
            () => setTimeout(() => reject(props.signal.reason), settleDelayMs),
            { once: true },
          )
        }),
    )
    return seen
  }
  it("does not execute work already cancelled by the caller", async () => {
    const test = await startedFixture()
    const controller = new AbortController()
    controller.abort(new Error("caller cancelled"))
    await expect(
      test.runtime.runDiscordCommand(command, "pre-cancelled", controller.signal),
    ).rejects.toThrow("Discord operation cancelled")
    expect(executeDiscordCommand).not.toHaveBeenCalled()
  })
  it("propagates caller cancellation and correlates the failure", async () => {
    const test = await startedFixture()
    const controller = new AbortController()
    const seen = abortableCommand()
    const operation = test.runtime.runDiscordCommand(
      command,
      "cancelled-request",
      controller.signal,
    )
    const rejected = expect(operation).rejects.toThrow(
      "external effects may already have been accepted",
    )
    controller.abort(new Error("caller cancelled"))
    await rejected
    expect(seen[0]?.aborted).toBe(true)
    expect(JSON.stringify(test.eventLog.query({ requestId: "cancelled-request" }))).toContain(
      "caller cancelled",
    )
  })
  it("cancels in-flight Discord work on stop and waits for it to settle", async () => {
    const test = await startedFixture()
    const seen = abortableCommand(20)
    const settled: string[] = []
    const operation = test.runtime.runDiscordCommand(command).catch((error: unknown) => {
      settled.push(String(error))
    })
    await test.runtime.stop()
    expect(seen[0]?.aborted).toBe(true)
    expect(settled).toEqual([expect.stringContaining("Discord operation cancelled")])
    await operation
  })
  it("reports unconfirmed Discord shutdown instead of waiting forever", async () => {
    vi.useFakeTimers()
    try {
      const test = await startedFixture()
      const delayed = Promise.withResolvers<unknown>()
      vi.mocked(executeDiscordCommand).mockReturnValueOnce(delayed.promise)
      const operation = test.runtime.runDiscordCommand(command).catch((error: unknown) => error)
      const stopping = test.runtime.stop().catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(1500)
      expect(
        errorDetails(await stopping).some((cause) =>
          cause.message.includes("Discord operations shutdown timed out"),
        ),
      ).toBe(true)
      active.splice(active.indexOf(test.runtime), 1)
      delayed.resolve({ id: "1" })
      expect(String(await operation)).toContain("Discord operation cancelled")
    } finally {
      vi.useRealTimers()
    }
  })
})
