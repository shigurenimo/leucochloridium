import { afterEach, describe, expect, it, vi } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { executeSlackCommand } from "@/actions/slack/execute-slack-command"
vi.mock("@/actions/slack/execute-slack-command", () => ({
  executeSlackCommand: vi.fn(async () => ({ ok: true })),
}))
const active: LeucoRuntime[] = []
afterEach(async () => {
  for (const runtime of active.splice(0)) await runtime.stop()
  vi.clearAllMocks()
})
function fixture() {
  const reference = "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d"
  const store = new MemoryLeucoStore({ slack: { credential: reference, ackMode: "off" } })
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
  return { runtime, credentials, codex, eventLog, reference }
}
const command = { words: ["slack", "call", "auth.test"], flags: { body: "{}" } }
describe("cached Slack credentials", () => {
  it("reads once at startup and uses the cached token for every Slack operation", async () => {
    const test = fixture()
    await test.credentials.set(
      test.reference,
      JSON.stringify({ botToken: "xoxb-bot-secret", appToken: "xapp-app-secret" }),
    )
    await test.runtime.start()
    await test.credentials.set(
      test.reference,
      JSON.stringify({ botToken: "xoxb-replacement", appToken: "xapp-replacement" }),
    )
    vi.mocked(executeSlackCommand).mockResolvedValueOnce({ ok: true, debug: "xoxb-bot-secret" })
    const reply = await test.runtime.runSlackCommand(command)
    expect(JSON.stringify(reply)).not.toContain("xoxb-bot-secret")
    await test.runtime.runSlackCommand(command)
    expect(test.credentials.reads).toEqual([test.reference])
    expect(executeSlackCommand).toHaveBeenLastCalledWith({
      parsed: command,
      botToken: "xoxb-bot-secret",
      upload: undefined,
    })
    await test.runtime.runTextTurn("cli", "work")
    expect(test.codex.starts).toHaveLength(1)
    expect(test.codex.turns).toHaveLength(1)
    expect(JSON.stringify([test.codex.starts, test.codex.turns])).not.toContain("secret")
    test.eventLog.log("info", "xoxb-bot-secret and xapp-app-secret")
    expect(JSON.stringify(test.eventLog.query())).not.toContain("xoxb-bot-secret")
    expect(JSON.stringify(test.eventLog.query())).not.toContain("xapp-app-secret")
    await test.runtime.stop()
    await expect(test.runtime.runSlackCommand(command)).rejects.toThrow("not running")
  })
  it("fails before spawning Codex when credentials are missing or malformed", async () => {
    const test = fixture()
    await test.credentials.set(test.reference, "not-json-sensitive")
    await expect(test.runtime.start()).rejects.toThrow("credentials are invalid")
    expect(test.codex.startCount).toBe(0)
    const missing = fixture()
    await expect(missing.runtime.start()).rejects.toThrow("credentials are missing")
    expect(missing.codex.startCount).toBe(0)
  })
  it("reports which token is missing before starting Codex", async () => {
    const test = fixture()
    await test.credentials.set(test.reference, JSON.stringify({ botToken: "xoxb-bot-secret" }))
    await expect(test.runtime.start()).rejects.toThrow("leuco slack login app")
    expect(test.codex.startCount).toBe(0)
  })
  it("does not resurrect credentials after a read completes following shutdown", async () => {
    const test = fixture()
    const pending = Promise.withResolvers<string | null>()
    vi.spyOn(test.credentials, "get").mockReturnValue(pending.promise)
    const starting = test.runtime.start()
    await test.runtime.stop()
    pending.resolve(JSON.stringify({ botToken: "xoxb-bot-secret", appToken: "xapp-app-secret" }))
    await expect(starting).rejects.toThrow("stopped during startup")
    expect(test.codex.startCount).toBe(0)
    await expect(test.runtime.runSlackCommand(command)).rejects.toThrow("not running")
  })
  it("does not return an in-flight response after shutdown clears credentials", async () => {
    const test = fixture()
    await test.credentials.set(
      test.reference,
      JSON.stringify({ botToken: "xoxb-bot-secret", appToken: "xapp-app-secret" }),
    )
    await test.runtime.start()
    const pending = Promise.withResolvers<{ ok: boolean; debug: string }>()
    vi.mocked(executeSlackCommand).mockImplementationOnce(() => pending.promise)
    const operation = test.runtime.runSlackCommand(command)
    await test.runtime.stop()
    pending.resolve({ ok: true, debug: "xoxb-bot-secret" })
    await expect(operation).rejects.toThrow("stopped during Slack operation")
  })
})
