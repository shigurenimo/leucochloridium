import { describe, expect, it, vi } from "vitest"
import type { handleDaemonRequest } from "@/daemon/handle-daemon-request"
import { createMemoryDaemonHandler } from "@/daemon/memory-daemon-handler"
import { CliError } from "@/cli/cli-error"

function createHandler(overrides: Partial<Parameters<typeof handleDaemonRequest>[0]> = {}) {
  const token = overrides.token ?? "secret"
  return createMemoryDaemonHandler({ token, secrets: [token], overrides }).handler
}

function fixture(authorizationToken = "secret") {
  const runTextTurn = vi.fn(async (_key: string, _text: string): Promise<string | Error> => "reply")
  const stop = vi.fn()
  const handler = createHandler({ token: authorizationToken, runTextTurn, stop })
  const request = (path: string, body?: unknown, token = authorizationToken) =>
    handler(
      new Request(`http://localhost${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-leuco-request-id": "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runTextTurn, stop, request }
}

describe("single daemon controls", () => {
  it.each([
    "type=",
    "requestId=",
    "sinceTs=1.5",
    "sinceTs=",
    "sinceTs=%20",
    "sinceTs=0x10",
    "limit=1e3",
    "limit=0x10",
    "sinceTs=9007199254740992",
    "since=1000",
    "limit=1&limit=2",
    "summary=true&summary=false",
    "type=error&type=error",
  ])("rejects invalid event filters before reading history: %s", async (query) => {
    const history = vi.fn(() => [])
    const handler = createHandler({
      getVolatileEvents: history,
    })
    const response = await handler(
      new Request(`http://localhost/events?${query}`, {
        headers: { authorization: "Bearer secret" },
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      failure: { code: "USAGE", details: { phase: "validation", executionStarted: false } },
    })
    expect(history).not.toHaveBeenCalled()
  })
  it.each<[string, unknown, string[]]>([
    ["/restart", { model: "retired-override" }, []],
    ["/restart", { soul: 42 }, ["soul"]],
    ["/restart", { cwd: "relative/work" }, ["cwd"]],
    ["/restart", { cwd: "" }, ["cwd"]],
    ["/restart", { soul: "SOUL.md" }, ["soul"]],
    ["/restart", { soul: "" }, ["soul"]],
    ["/slack", { words: ["slack", "call", "auth.test"], flags: { body: 42 } }, ["flags", "body"]],
  ])("reports input issues before invoking %s", async (path, body, issuePath) => {
    const operation = vi.fn(async () => "reply")
    const handler = createHandler({
      runTextTurn: operation,
      runSlackCommand: operation,
      restart: operation,
    })
    const response = await handler(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      failure: {
        code: "USAGE",
        details: {
          phase: "validation",
          executionStarted: false,
          issues: [expect.objectContaining({ path: issuePath })],
        },
      },
    })
    expect(operation).not.toHaveBeenCalled()
  })
  it.each<[string, unknown]>([
    ["/restart", {}],
    ["/slack", { words: ["slack", "call", "auth.test"], flags: { body: "{}" } }],
  ])("does not label an invoked %s callback failure as pre-execution", async (path, body) => {
    const operation = vi.fn(() => {
      throw new CliError("USAGE", "callback failed after execution began")
    })
    const handler = createHandler({
      runTextTurn: operation,
      runSlackCommand: operation,
      restart: operation,
    })
    const response = await handler(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
    expect(operation).toHaveBeenCalledOnce()
    const failure: unknown = await response.json()
    expect(failure).toMatchObject({ failure: { code: "USAGE" } })
    expect(failure).not.toMatchObject({ failure: { details: { executionStarted: false } } })
  })
  it.each(["/turn", "/restart", "/slack", "/discord", "/stop"])(
    "classifies malformed JSON as pre-execution rejection for %s",
    async (path) => {
      const operation = vi.fn(async () => "reply")
      const handler = createHandler({
        runTextTurn: operation,
        runDiscordCommand: operation,
        runSlackCommand: operation,
        restart: operation,
        stop: operation,
      })
      const response = await handler(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: "{",
        }),
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        failure: {
          code: "USAGE",
          details: { phase: "control-body", executionStarted: false },
          causes: expect.arrayContaining([expect.objectContaining({ name: "SyntaxError" })]),
        },
      })
      expect(operation).not.toHaveBeenCalled()
    },
  )
  it.each(["model", "agent", "instructions", "codexBin"])(
    "rejects an unsupported turn field %s before execution",
    async (field) => {
      const setup = fixture()
      const response = await setup.request("/turn", {
        text: "perform work",
        [field]: "ignored-override",
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        failure: {
          code: "USAGE",
          details: {
            executionStarted: false,
            issues: [{ code: "unrecognized_keys", message: expect.stringContaining(field) }],
          },
        },
      })
      expect(setup.runTextTurn).not.toHaveBeenCalled()
    },
  )
  it("masks the control credential in unknown-field diagnostics before clipping", async () => {
    const secret = "synthetic-control-private-key"
    const setup = fixture(secret)
    const field = `${"p".repeat(960)}${secret}${"q".repeat(1500)}`
    const response = await setup.request("/turn", { text: "perform work", [field]: "ignored" })
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).not.toContain(secret.slice(0, 8))
    expect(setup.runTextTurn).not.toHaveBeenCalled()
  })
  it.each(["", "   ", "\n\t", "　"])(
    "rejects a blank control prompt before dispatch: %j",
    async (text) => {
      const setup = fixture()
      const response = await setup.request("/turn", { text })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        failure: {
          code: "USAGE",
          details: {
            phase: "validation",
            executionStarted: false,
            issues: expect.arrayContaining([expect.objectContaining({ path: ["text"] })]),
          },
        },
      })
      expect(setup.runTextTurn).not.toHaveBeenCalled()
    },
  )
  it.each([false, true])(
    "does not label a callback failure as a pre-execution rejection (throws: %s)",
    async (throws) => {
      const setup = fixture()
      const failure = new CliError("USAGE", "callback failed after execution began")
      if (throws) setup.runTextTurn.mockRejectedValueOnce(failure)
      else setup.runTextTurn.mockResolvedValueOnce(failure)
      const response = await setup.request("/turn", { text: "perform work" })
      expect(setup.runTextTurn).toHaveBeenCalledOnce()
      const body: unknown = await response.json()
      expect(body).toMatchObject({ failure: { code: "USAGE" } })
      expect(body).not.toMatchObject({ failure: { details: { executionStarted: false } } })
    },
  )
  it("rejects oversized JSON control bodies before accepting work", async () => {
    const runTextTurn = vi.fn(async () => "reply")
    const handler = createHandler({
      runTextTurn,
    })
    const response = await handler(
      new Request("http://localhost/turn", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "content-length": String(4 * 1024 * 1024 + 1),
        },
        body: JSON.stringify({ text: "work" }),
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      failure: {
        code: "USAGE",
        details: { phase: "control-body", executionStarted: false },
      },
    })
    expect(runTextTurn).not.toHaveBeenCalled()
  })
  it("rejects unauthenticated work and stop requests", async () => {
    const test = fixture()
    expect((await test.request("/turn", { text: "work" }, "wrong")).status).toBe(401)
    expect((await test.request("/stop", {}, "wrong")).status).toBe(401)
    expect(test.runTextTurn).not.toHaveBeenCalled()
    expect(test.stop).not.toHaveBeenCalled()
  })
  it("runs a request and reports only the internal reply", async () => {
    const test = fixture()
    expect(await (await test.request("/turn", { key: "cli", text: "work" })).json()).toEqual({
      reply: "reply",
    })
    expect(test.runTextTurn).toHaveBeenCalledWith(
      "cli",
      "work",
      "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
    )
  })
  it.each<[string, number]>([
    ["returned", 0],
    ["thrown", 1],
  ])("reports a %s turn failure without a reply and logs it %s times", async (delivery, logged) => {
    const failure = new Error("Codex rejected private-bot-token")
    const daemon = createMemoryDaemonHandler({
      token: "secret",
      secrets: ["secret", "private-bot-token"],
      overrides: {
        runTextTurn: async () => {
          if (delivery === "thrown") throw failure
          return failure
        },
      },
    })
    const log = daemon.log
    const handler = daemon.handler
    const response = await handler(
      new Request("http://localhost/turn", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-leuco-request-id": "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
        },
        body: JSON.stringify({ text: "work" }),
      }),
    )
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: "Codex rejected [redacted]",
      requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
    })
    expect(log.query()).toHaveLength(logged)
  })
  it("correlates an authenticated shutdown with its request ID", async () => {
    const test = fixture()
    expect((await test.request("/stop", {})).status).toBe(200)
    expect(test.stop).toHaveBeenCalledWith("6e6d9bcc-a07c-4c72-93f0-7eb651f9711d")
  })
  it("rejects malformed and oversized inputs before starting work", async () => {
    const test = fixture()
    expect((await test.request("/turn", { text: "" })).status).toBe(400)
    expect((await test.request("/turn", { text: "x".repeat(300 * 1024) })).status).toBe(400)
    expect(test.runTextTurn).not.toHaveBeenCalled()
  })
  it("does not confirm shutdown until resources have actually finished closing", async () => {
    const closing = Promise.withResolvers<void>()
    const observation = { returned: false }
    const handler = createHandler({
      awaitStop: () => closing.promise,
    })
    const response = handler(
      new Request("http://localhost/stop", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      }),
    ).then((reply) => {
      observation.returned = true
      return reply
    })
    await Promise.resolve()
    expect(observation.returned).toBe(false)
    closing.resolve()
    expect(await (await response).json()).toMatchObject({ stopped: true, processWillExit: false })
  })
})

it.each<[string, unknown]>([
  ["/status", undefined],
  ["/events", undefined],
  ["/stop", undefined],
  ["/restart", {}],
  ["/discord", { words: ["discord", "call", "GET", "/users/@me"], flags: {} }],
  ["/slack", { words: ["slack", "call", "auth.test"], flags: { body: "{}" } }],
  ["/turn", { text: "work" }],
])("correlates unexpected %s failures with the accepted request ID", async (path, body) => {
  const requestId = "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d"
  const primary = Object.assign(new Error("injected control failure"), { code: "EIO" })
  const report = vi.fn(() => "safe control failure")
  const fail = () => {
    throw primary
  }
  const handler = createHandler({
    getRuntimeStatus: fail,
    getVolatileEvents: fail,
    restart: fail,
    runTextTurn: fail,
    runDiscordCommand: fail,
    runSlackCommand: fail,
    stop: fail,
    reportError: report,
  })
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method: ["/status", "/events"].includes(path) ? "GET" : "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-leuco-request-id": requestId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ error: "safe control failure", requestId })
  expect(report).toHaveBeenCalledExactlyOnceWith(primary, requestId)
})

it.each(["r".repeat(513), "記録".repeat(300)])(
  "preserves a long request-ID search filter",
  async (requestId) => {
    const events = [
      { seq: 1, ts: 1, event: { ts: 1, type: "log", level: "info", line: "recorded", requestId } },
    ]
    const query = vi.fn(() => events)
    const handler = createHandler({
      getVolatileEvents: query,
    })
    const response = await handler(
      new Request(`http://localhost/events?${new URLSearchParams({ requestId })}`, {
        headers: { authorization: "Bearer secret" },
      }),
    )
    expect(response.status).toBe(200)
    expect(query).toHaveBeenCalledExactlyOnceWith({ limit: 100, requestId })
    expect(await response.json()).toEqual(events)
  },
)

it("does not expose stack traces or the expected token in an authentication rejection", async () => {
  const test = fixture()
  const response = await test.request("/turn", { text: "never execute" }, "wrong")
  const body = await response.json()
  expect(body).toMatchObject({
    error: "Unauthorized",
    requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
    failure: {
      code: "STATE_CONFLICT",
      details: { phase: "authorization", executionStarted: false },
      causes: [],
    },
  })
  expect(JSON.stringify(body)).not.toContain("/Users/")
  expect(JSON.stringify(body)).not.toContain("secret")
})

it.each([
  { words: ["slack", "upload-file"], flags: { file: "/caller/report.txt" } },
  { words: ["status"], flags: {} },
  { words: ["slack", "call", "auth.test"], flags: { body: "{}" } },
  { words: ["slack", "download-file"], flags: { file: "F123", out: "/caller/report.txt" } },
])("rejects multipart command %j before executing an operation", async (command) => {
  const operation = vi.fn(async () => ({}))
  const form = new FormData()
  form.set("command", JSON.stringify(command))
  form.set("file", new Blob(["upload bytes"]), "upload")
  const request = new Request("http://localhost/slack", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
    body: form,
  })
  const handler = createHandler({
    runSlackCommand: operation,
  })
  const response = await handler(request)
  expect(response.ok).toBe(false)
  expect(operation).not.toHaveBeenCalled()
})

it.each(["json", "missing-file", "text-file"])(
  "rejects upload without file bytes before invoking the operation: %s",
  async (transport) => {
    const command = {
      words: ["slack", "upload-file"],
      flags: { file: "/caller/report.txt", channel: "C123" },
    }
    const form = new FormData()
    form.set("command", JSON.stringify(command))
    if (transport === "text-file") form.set("file", "path-only")
    const operation = vi.fn(async () => ({}))
    const handler = createHandler({
      runSlackCommand: operation,
    })
    const response = await handler(
      new Request("http://localhost/slack", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          ...(transport === "json" ? { "content-type": "application/json" } : {}),
        },
        body: transport === "json" ? JSON.stringify(command) : form,
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      failure: { code: "USAGE", details: { phase: "validation", executionStarted: false } },
    })
    expect(operation).not.toHaveBeenCalled()
  },
)

it.each(["あ".repeat(87382), "😀".repeat(65537)])(
  "rejects a Unicode prompt above the UTF-8 byte limit before dispatch (%#)",
  async (text) => {
    const setup = fixture()
    const response = await setup.request("/turn", { text })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      failure: { code: "USAGE", details: { phase: "validation", executionStarted: false } },
    })
    expect(setup.runTextTurn).not.toHaveBeenCalled()
  },
)

it.each([`${"あ".repeat(87381)}x`, "😀".repeat(65536)])(
  "accepts a Unicode prompt exactly at the UTF-8 byte limit (%#)",
  async (text) => {
    const setup = fixture()
    expect(Buffer.byteLength(text, "utf8")).toBe(262144)
    const response = await setup.request("/turn", { text })
    expect(response.status).toBe(200)
    expect(setup.runTextTurn).toHaveBeenCalledOnce()
  },
)

it.each<[string, unknown]>([
  ["__proto__", true],
  ["__proto__", "ignored"],
  ["__proto__", 42],
  ["constructor", true],
  ["toString", true],
  ["unsupported-flag", true],
])("rejects the literal control flag %s before dispatch (%#)", async (name, value) => {
  const operation = vi.fn(async () => ({}))
  const handler = createHandler({
    runSlackCommand: operation,
  })
  const response = await handler(
    new Request("http://localhost/slack", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        words: ["slack", "call", "auth.test"],
        flags: Object.fromEntries([
          ["body", "{}"],
          [name, value],
        ]),
      }),
    }),
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    failure: { code: "USAGE", details: { phase: "validation", executionStarted: false } },
  })
  expect(operation).not.toHaveBeenCalled()
})

it.each([["status"], ["slack", "logout"]])(
  "classifies non-Slack-control commands as input rejection: %j",
  async (...words) => {
    const operation = vi.fn(async () => ({}))
    const handler = createHandler({
      runSlackCommand: operation,
    })
    const response = await handler(
      new Request("http://localhost/slack", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ words, flags: {} }),
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      failure: { code: "USAGE", details: { phase: "validation", executionStarted: false } },
    })
    expect(operation).not.toHaveBeenCalled()
  },
)

it.each(["json", "multipart"])("rejects help before Slack execution through %s", async (format) => {
  const operation = vi.fn(async () => ({ ok: true }))
  const handler = createHandler({
    runSlackCommand: operation,
  })
  const multipart = new FormData()
  multipart.set(
    "command",
    JSON.stringify({
      words: ["slack", "upload-file"],
      flags: { channel: "C1", file: "/unused", help: true },
    }),
  )
  multipart.set("file", new Blob(["probe"]), "probe.txt")
  const response = await handler(
    new Request("http://localhost/slack", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        ...(format === "json" ? { "content-type": "application/json" } : {}),
      },
      body:
        format === "json"
          ? JSON.stringify({
              words: ["slack", "call", "chat.postMessage"],
              flags: { body: '{"channel":"C1","text":"probe"}', help: true },
            })
          : multipart,
    }),
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    failure: { code: "USAGE", details: { phase: "validation", executionStarted: false } },
  })
  expect(operation).not.toHaveBeenCalled()
})

it.each([{ help: true }, { force: true }, null, [], "unexpected"])(
  "rejects an invalid shutdown body before stopping: %j",
  async (body) => {
    const test = fixture()
    const response = await test.request("/stop", body)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      failure: { code: "USAGE", details: { executionStarted: false } },
    })
    expect(test.stop).not.toHaveBeenCalled()
  },
)

it("rejects malformed shutdown JSON before stopping", async () => {
  const stop = vi.fn()
  const handler = createHandler({
    stop,
  })
  const response = await handler(
    new Request("http://localhost/stop", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: "{",
    }),
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    failure: { code: "USAGE", details: { executionStarted: false } },
  })
  expect(stop).not.toHaveBeenCalled()
})

it.each(["/status", "/turn", "/stop", "/restart", "/slack"])(
  "rejects unsupported query parameters before invoking %s",
  async (path) => {
    const work = vi.fn(async () => "reply")
    const observe = vi.fn(() => ({}))
    const stop = vi.fn()
    const ready = vi.fn(() => true)
    const handler = createHandler({
      isReady: ready,
      runTextTurn: work,
      runSlackCommand: work,
      restart: observe,
      getRuntimeStatus: observe,
      stop,
    })
    const body =
      path === "/turn"
        ? { text: "probe" }
        : path === "/slack"
          ? { words: ["slack", "call", "auth.test"], flags: { body: "{}" } }
          : {}
    const response = await handler(
      new Request(`http://localhost${path}?force=true`, {
        method: path === "/status" ? "GET" : "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        ...(path === "/status" ? {} : { body: JSON.stringify(body) }),
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      failure: { code: "USAGE", details: { phase: "validation", executionStarted: false } },
    })
    expect(work).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
  },
)

it.each<[string, (form: FormData) => void]>([
  ["non-text command", (form) => form.set("command", new Blob(["{}"]), "command.json")],
  ["invalid command JSON", (form) => form.set("command", "{")],
  ["oversized command", (form) => form.set("command", "x".repeat(4 * 1024 * 1024 + 1))],
  [
    "oversized file",
    (form) => form.set("file", new Blob([new Uint8Array(100 * 1024 * 1024 + 1)]), "upload"),
  ],
])("classifies a multipart %s as a pre-execution control-body rejection", async (_label, edit) => {
  const operation = vi.fn(async () => ({}))
  const daemon = createMemoryDaemonHandler({
    token: "secret",
    secrets: ["secret"],
    overrides: { runSlackCommand: operation },
  })
  const form = new FormData()
  form.set(
    "command",
    JSON.stringify({ words: ["slack", "upload-file"], flags: { file: "/c/r", channel: "C1" } }),
  )
  form.set("file", new Blob(["bytes"]), "upload")
  edit(form)
  const response = await daemon.handler(
    new Request("http://localhost/slack", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: form,
    }),
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    failure: { code: "USAGE", details: { phase: "control-body", executionStarted: false } },
  })
  expect(daemon.log.query()).toEqual([
    expect.objectContaining({ event: expect.objectContaining({ level: "warn" }) }),
  ])
  expect(operation).not.toHaveBeenCalled()
})
