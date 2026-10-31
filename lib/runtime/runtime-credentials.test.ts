import { afterEach, describe, expect, it, vi } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { executeSlackCommand } from "@/actions/slack/execute-slack-command"
import { errorDetails } from "@/error-details"
import type { CliArguments } from "@/cli/parse-arguments"
vi.mock("@/actions/slack/execute-slack-command", () => ({
  executeSlackCommand: vi.fn(async () => ({ ok: true })),
}))
const active: LeucoRuntime[] = []
afterEach(async () => {
  for (const runtime of active.splice(0)) await runtime.stop()
  vi.clearAllMocks()
  vi.useRealTimers()
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
async function startedFixture() {
  const test = fixture()
  await test.credentials.set(
    test.reference,
    JSON.stringify({ botToken: "xoxb-bot-secret", appToken: "xapp-app-secret" }),
  )
  test.eventLog.addRedactionSecrets(["synthetic-control-token"])
  await test.runtime.start()
  return test
}
describe("cached Slack credentials", () => {
  it.each([-60000, 60000])(
    "keeps Slack elapsed time and failure logs when wall time shifts by %i ms",
    async (shift) => {
      vi.useFakeTimers()
      const test = await startedFixture()
      const delayed = Promise.withResolvers<unknown>()
      vi.mocked(executeSlackCommand).mockReturnValueOnce(delayed.promise)
      const pending = test.runtime
        .runSlackCommand(command, { requestId: "slack-clock" })
        .catch((error: unknown) => error)
      const startedAt = Date.now()
      await vi.advanceTimersByTimeAsync(100)
      vi.setSystemTime(Date.now() + shift)
      try {
        expect(test.runtime.getStatus().slack.requests[0]).toMatchObject({
          startedAt,
          elapsedMs: 100,
        })
      } finally {
        delayed.reject(new Error("synthetic Slack failure"))
        await pending
      }
      expect(await pending).toBeInstanceOf(Error)
      const history = JSON.stringify(test.eventLog.query({ requestId: "slack-clock" }))
      expect(history).toContain("Slack operation failed after 100 ms")
      expect(history).toContain("Slack operation finished after 100 ms")
    },
  )
  it("retains control-token masking after loading Slack credentials", async () => {
    const test = await startedFixture()
    test.eventLog.log("error", "control synthetic-control-token and xoxb-bot-secret")
    const history = JSON.stringify(test.eventLog.query())
    expect(history).not.toContain("synthetic-control-token")
    expect(history).not.toContain("xoxb-bot-secret")
    expect(history).toContain("[redacted]")
  })
  it("shows in-flight Slack work independently of the Codex queue without exposing payloads", async () => {
    const test = await startedFixture()
    const delayed = Promise.withResolvers<unknown>()
    vi.mocked(executeSlackCommand).mockReturnValueOnce(delayed.promise)
    const pending = test.runtime.runSlackCommand(
      {
        words: ["slack", "call", "chat.postMessage"],
        flags: { body: JSON.stringify({ channel: "C-private", text: "private message" }) },
      },
      { requestId: "slack-request" },
    )
    try {
      const status = test.runtime.getStatus()
      expect(status).toMatchObject({
        active: null,
        queue: { waiting: 0 },
        slack: {
          active: 1,
          requests: [
            {
              requestId: "slack-request",
              action: "call",
              startedAt: expect.any(Number),
              elapsedMs: expect.any(Number),
              cancellationRequested: false,
            },
          ],
        },
      })
      expect(JSON.stringify(status)).not.toContain("private")
      status.slack.requests[0]!.requestId = "modified-by-consumer"
      expect(test.runtime.getStatus().slack.requests[0]?.requestId).toBe("slack-request")
    } finally {
      delayed.resolve({ ok: true })
    }
    await pending
    expect(test.runtime.getStatus()).toMatchObject({ slack: { active: 0, requests: [] } })
  })
  it("reports unconfirmed Slack shutdown instead of waiting forever", async () => {
    vi.useFakeTimers()
    const test = await startedFixture()
    const delayed = Promise.withResolvers<unknown>()
    vi.mocked(executeSlackCommand).mockReturnValueOnce(delayed.promise)
    const operation = test.runtime.runSlackCommand(command).catch((error: unknown) => error)
    const stopping = test.runtime.stop().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1500)
    const causes = errorDetails(await stopping)
    expect(
      causes.some((cause) => cause.message.includes("Slack operations shutdown timed out")),
    ).toBe(true)
    active.splice(active.indexOf(test.runtime), 1)
    expect(test.runtime.getStatus()).toMatchObject({
      slack: { active: 1, requests: [{ cancellationRequested: true }] },
    })
    delayed.resolve({ ok: true })
    expect(String(await operation)).toContain("Slack operation cancelled")
  })
  it("does not execute work already cancelled by the caller", async () => {
    const test = await startedFixture()
    const controller = new AbortController()
    controller.abort(new Error("caller cancelled"))
    await expect(
      test.runtime.runSlackCommand(command, { signal: controller.signal }),
    ).rejects.toThrow("Slack operation cancelled")
    expect(executeSlackCommand).not.toHaveBeenCalled()
  })
  it("propagates caller cancellation and correlates the failure", async () => {
    const test = await startedFixture()
    const controller = new AbortController()
    vi.mocked(executeSlackCommand).mockImplementationOnce(
      async (props) =>
        new Promise((_resolve, reject) => {
          props.signal?.addEventListener("abort", () => reject(props.signal?.reason), {
            once: true,
          })
        }),
    )
    const operation = test.runtime.runSlackCommand(command, {
      signal: controller.signal,
      requestId: "cancelled-request",
    })
    const rejected = expect(operation).rejects.toThrow(
      "external effects may already have been accepted",
    )
    controller.abort(new Error("caller cancelled"))
    await rejected
    expect(JSON.stringify(test.eventLog.query({ requestId: "cancelled-request" }))).toContain(
      "caller cancelled",
    )
    expect(test.runtime.getStatus().slack).toEqual({ active: 0, requests: [] })
  })
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
      signal: expect.any(AbortSignal),
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
    vi.mocked(executeSlackCommand).mockImplementationOnce(async (props) => {
      return new Promise((_resolve, reject) => {
        props.signal?.addEventListener("abort", () => reject(props.signal?.reason), { once: true })
      })
    })
    const operation = test.runtime.runSlackCommand(command)
    const rejected = expect(operation).rejects.toThrow("Slack operation cancelled")
    await test.runtime.stop()
    await rejected
  })
})

it("redacts escaped known values in a Slack JSON reply without failing the accepted operation", async () => {
  const test = await startedFixture()
  const secret = 'synthetic"private\\\nvalue'
  test.eventLog.addRedactionSecrets([secret])
  vi.mocked(executeSlackCommand).mockResolvedValueOnce({
    ok: true,
    nested: { [secret]: secret },
    intact: "日本語",
  })
  expect(await test.runtime.runSlackCommand(command)).toEqual({
    ok: true,
    nested: { "[redacted]": "[redacted]" },
    intact: "日本語",
  })
})

it.each(["operation", "flag"])(
  "classifies an invalid SDK Slack %s before execution",
  async (kind) => {
    const test = fixture()
    const parsed: CliArguments =
      kind === "operation"
        ? { words: ["status"], flags: {} }
        : { words: ["slack", "call", "auth.test"], flags: { body: "{}", unknown: true } }
    const failure = await test.runtime.runSlackCommand(parsed).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: "USAGE",
      details: { phase: "validation", executionStarted: false },
    })
    expect(executeSlackCommand).not.toHaveBeenCalled()
    expect(test.runtime.getStatus().slack.active).toBe(0)
    expect(test.eventLog.query({ type: "log" })).toEqual([])
  },
)

const slackHelpCommands: CliArguments[] = [
  {
    words: ["slack", "call", "chat.postMessage"],
    flags: { body: '{"channel":"C1","text":"probe"}', help: true },
  },
  { words: ["slack", "upload-file"], flags: { channel: "C1", file: "/unused", help: true } },
  { words: ["slack", "download-file"], flags: { file: "F1", out: "/unused", help: true } },
]
it.each(slackHelpCommands)(
  "rejects help input at the SDK execution boundary: %j",
  async (parsed) => {
    const test = await startedFixture()
    await expect(
      test.runtime.runSlackCommand(parsed, { requestId: "help-probe" }),
    ).rejects.toMatchObject({
      code: "USAGE",
      details: { phase: "validation", executionStarted: false },
    })
    expect(executeSlackCommand).not.toHaveBeenCalled()
    expect(test.eventLog.query({ type: "log", requestId: "help-probe" })).toEqual([])
  },
)

it.each(["failure", "cancelled"])(
  "returns a masked SDK Slack cause chain after %s",
  async (outcome) => {
    const test = await startedFixture()
    const controller = new AbortController()
    const primary = Object.assign(
      new Error("api failure xoxb-bot-secret", {
        cause: new Error("nested xapp-app-secret and synthetic-control-token"),
      }),
      { code: "EIO", debugToken: "xoxb-bot-secret" },
    )
    vi.mocked(executeSlackCommand).mockImplementationOnce(async () => {
      if (outcome === "cancelled") controller.abort(primary)
      throw primary
    })
    const failure = await test.runtime
      .runSlackCommand(command, { signal: controller.signal })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const diagnostic: string[] = []
    const current: { error: unknown } = { error: failure }
    for (const _ of Array.from({ length: 12 })) {
      if (!(current.error instanceof Error)) break
      diagnostic.push(
        current.error.message,
        current.error.stack ?? "",
        JSON.stringify(current.error),
      )
      current.error = current.error.cause
    }
    const raw = diagnostic.join("\n")
    for (const secret of ["xoxb-bot-secret", "xapp-app-secret", "synthetic-control-token"])
      expect(raw).not.toContain(secret)
    expect(errorDetails(failure).some((cause) => cause.code === "EIO")).toBe(true)
    expect(primary.message).toContain("xoxb-bot-secret")
  },
)
