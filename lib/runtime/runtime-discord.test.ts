import { afterEach, describe, expect, it, vi } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { executeDiscordCommand } from "@/actions/discord/execute-discord-command"

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
    expect(executeDiscordCommand).toHaveBeenLastCalledWith({ parsed: command, botToken: secret })
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
    await test.runtime.stop()
    pending.resolve({ debug: secret })
    await expect(operation).rejects.toThrow("stopped during Discord operation")
  })
})
