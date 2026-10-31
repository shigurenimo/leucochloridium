import { describe, expect, it } from "vitest"
import { LeucoCodexProtocol } from "@/engine/codex/codex-protocol"

const harness = () => {
  const written: string[] = []
  const protocol = new LeucoCodexProtocol({ writer: (line) => written.push(line) })
  return { protocol, written }
}

describe("LeucoCodexProtocol.request", () => {
  it("encodes JSON-RPC request and resolves on matching response", async () => {
    const h = harness()
    const promise = h.protocol.request("foo", { a: 1 })

    expect(h.written).toHaveLength(1)
    const sent = JSON.parse(h.written[0]!)
    expect(sent).toEqual({ jsonrpc: "2.0", id: 1, method: "foo", params: { a: 1 } })

    h.protocol.feedChunk(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n`)
    await expect(promise).resolves.toEqual({ ok: true })
  })

  it("rejects with code+message on error responses", async () => {
    const h = harness()
    const promise = h.protocol.request("foo")
    h.protocol.feedChunk(`{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"nope"}}\n`)
    await expect(promise).rejects.toThrow("nope (code -1)")
  })

  it("assigns monotonically increasing ids", async () => {
    const h = harness()
    h.protocol.request("a")
    h.protocol.request("b")
    h.protocol.request("c")
    expect(h.written.map((s) => JSON.parse(s).id)).toEqual([1, 2, 3])
  })

  it("buffers partial lines across chunks", async () => {
    const h = harness()
    const p = h.protocol.request("foo")
    h.protocol.feedChunk(`{"jsonrpc":"2.0","id":1,`)
    h.protocol.feedChunk(`"result":{"ok":true}}\n`)
    await expect(p).resolves.toEqual({ ok: true })
  })

  it("dispatches multiple lines arriving in one chunk", async () => {
    const h = harness()
    const a = h.protocol.request("a")
    const b = h.protocol.request("b")
    h.protocol.feedChunk(
      `{"jsonrpc":"2.0","id":1,"result":1}\n{"jsonrpc":"2.0","id":2,"result":2}\n`,
    )
    await expect(a).resolves.toBe(1)
    await expect(b).resolves.toBe(2)
  })

  it("ignores responses whose id has no matching pending request", () => {
    const h = harness()
    expect(() => h.protocol.feedChunk(`{"jsonrpc":"2.0","id":99,"result":null}\n`)).not.toThrow()
  })
})

describe("LeucoCodexProtocol.notify", () => {
  it("encodes JSON-RPC notification without id", () => {
    const h = harness()
    h.protocol.notify("hello", { x: 1 })
    expect(JSON.parse(h.written[0]!)).toEqual({
      jsonrpc: "2.0",
      method: "hello",
      params: { x: 1 },
    })
  })
})

describe("LeucoCodexProtocol notification handler", () => {
  it("forwards incoming notifications to the registered handler", () => {
    const h = harness()
    const events: { method: string; params: unknown }[] = []
    h.protocol.onNotification((method, params) => events.push({ method, params }))

    h.protocol.feedChunk(`{"jsonrpc":"2.0","method":"ping","params":{"n":7}}\n`)

    expect(events).toEqual([{ method: "ping", params: { n: 7 } }])
  })

  it("can clear a notification handler", () => {
    const h = harness()
    const events: string[] = []
    h.protocol.onNotification((method) => events.push(method))
    h.protocol.onNotification(null)

    h.protocol.feedChunk(`{"jsonrpc":"2.0","method":"ping"}\n`)

    expect(events).toEqual([])
  })

  it("tolerates JSON that fails the schema", () => {
    const h = harness()
    expect(() => h.protocol.feedChunk(`{"unknown":"shape"}\n`)).not.toThrow()
  })

  it("tolerates non-JSON lines", () => {
    const h = harness()
    expect(() => h.protocol.feedChunk(`not json\n`)).not.toThrow()
  })

  it.each([
    { line: "x".repeat(500), prefix: "[codex non-json]" },
    { line: JSON.stringify({ unknown: "x".repeat(500) }), prefix: "[codex unknown]" },
  ])("bounds $prefix diagnostic previews", ({ line, prefix }) => {
    const logs: string[] = []
    const protocol = new LeucoCodexProtocol({
      writer: () => undefined,
      onLog: (logLine) => logs.push(logLine),
      maxFrameChars: 1_024,
      logPreviewChars: 80,
    })

    expect(protocol.feedChunk(`${line}\n`)).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(prefix)
    expect(logs[0]!.length).toBeLessThanOrEqual(prefix.length + 1 + 80)
    expect(logs[0]).toContain("chars]")
  })
})

describe("LeucoCodexProtocol frame bounds", () => {
  it("rejects pending work when an unterminated frame exceeds the limit", async () => {
    const logs: string[] = []
    const protocol = new LeucoCodexProtocol({
      writer: () => undefined,
      onLog: (line) => logs.push(line),
      maxFrameChars: 128,
    })
    const pending = protocol.request("thread/start")

    const result = protocol.feedChunk("x".repeat(129))

    expect(result).toEqual(
      new Error("codex protocol frame exceeded 128 characters (received at least 129)"),
    )
    await expect(pending).rejects.toThrow("codex protocol frame exceeded 128 characters")
    expect(logs).toEqual([
      "[codex protocol] codex protocol frame exceeded 128 characters (received at least 129)",
    ])
  })

  it("rejects a completed oversized frame without logging its contents", () => {
    const logs: string[] = []
    const protocol = new LeucoCodexProtocol({
      writer: () => undefined,
      onLog: (line) => logs.push(line),
      maxFrameChars: 128,
    })

    const result = protocol.feedChunk(`${"secret".repeat(30)}\n`)

    expect(result).toBeInstanceOf(Error)
    expect(logs.join("\n")).not.toContain("secret")
  })

  it("accepts many bounded frames delivered in one aggregate chunk", () => {
    const methods: string[] = []
    const protocol = new LeucoCodexProtocol({
      writer: () => undefined,
      maxFrameChars: 64,
    })
    protocol.onNotification((method) => methods.push(method))

    const frame = `{"method":"ping"}\n`
    expect(protocol.feedChunk(frame.repeat(20))).toBeNull()
    expect(methods).toHaveLength(20)
  })
})

describe("LeucoCodexProtocol.fail", () => {
  it("rejects every in-flight request", async () => {
    const h = harness()
    const a = h.protocol.request("a")
    const b = h.protocol.request("b")
    h.protocol.fail(new Error("transport gone"))
    await expect(a).rejects.toThrow("transport gone")
    await expect(b).rejects.toThrow("transport gone")
  })

  it("does not affect later requests once the protocol is reused", async () => {
    const h = harness()
    h.protocol.fail(new Error("gone"))
    const next = h.protocol.request("foo")
    h.protocol.feedChunk(`{"jsonrpc":"2.0","id":1,"result":"ok"}\n`)
    await expect(next).resolves.toBe("ok")
  })
})

describe("LeucoCodexProtocol server-initiated requests", () => {
  it("replies with a JSON-RPC error instead of dropping server→client requests", () => {
    const h = harness()
    const notifications: string[] = []
    h.protocol.onNotification((method) => notifications.push(method))

    h.protocol.feedChunk(`{"jsonrpc":"2.0","id":7,"method":"execCommandApproval","params":{}}\n`)

    expect(notifications).toEqual([])
    expect(h.written).toHaveLength(1)
    const reply = JSON.parse(h.written[0]!)
    expect(reply.id).toBe(7)
    expect(reply.error.code).toBe(-32601)
  })

  it("replies to server requests that use string ids", () => {
    const h = harness()
    const notifications: string[] = []
    h.protocol.onNotification((method) => notifications.push(method))

    h.protocol.feedChunk(
      `{"jsonrpc":"2.0","id":"approval-7","method":"execCommandApproval","params":{}}\n`,
    )

    expect(notifications).toEqual([])
    expect(h.written).toHaveLength(1)
    const reply = JSON.parse(h.written[0]!)
    expect(reply.id).toBe("approval-7")
    expect(reply.error.code).toBe(-32601)
  })

  it("does not settle a pending client request with a same-id server request", async () => {
    const h = harness()
    const promise = h.protocol.request("foo")

    h.protocol.feedChunk(`{"jsonrpc":"2.0","id":1,"method":"someServerAsk","params":{}}\n`)
    h.protocol.feedChunk(`{"jsonrpc":"2.0","id":1,"result":"ok"}\n`)

    await expect(promise).resolves.toBe("ok")
  })
})

it("masks standard tokens before clipping malformed stdout previews", () => {
  const logs: string[] = []
  const protocol = new LeucoCodexProtocol({
    writer: () => {},
    onLog: (line) => logs.push(line),
    logPreviewChars: 64,
  })
  protocol.feedChunk(`${"x".repeat(28)} xoxb-synthetic-preview-token ${"y".repeat(1000)}\n`)
  expect(logs[0]).toContain("[redacted]")
  expect(logs[0]).not.toContain("synthetic")
})
it("masks complete owner secrets before clipping malformed and unknown stdout", () => {
  const secret = "control-0123456789-abcdefghijklmnop"
  const logs: string[] = []
  const protocol = new LeucoCodexProtocol({
    writer: () => {},
    onLog: (line) => logs.push(line),
    logPreviewChars: 96,
    redactLogText: (line) => line.split(secret).join("[redacted]"),
  })
  protocol.feedChunk(`${"x".repeat(60)} ${secret} ${"y".repeat(1000)}\n`)
  protocol.feedChunk(
    `${JSON.stringify({ unknown: `${"x".repeat(47)} ${secret} ${"y".repeat(1000)}` })}\n`,
  )
  expect(logs).toHaveLength(2)
  for (const line of logs) {
    expect(line).toContain("[redacted]")
    expect(line).not.toContain("control-")
  }
})
it("does not split Unicode at the protocol diagnostic preview boundary", () => {
  const logs: string[] = []
  const suffix = "… [256 chars]"
  const prefix = 64 - suffix.length
  const line = `${"x".repeat(prefix - 1)}😀${"y".repeat(256 - prefix - 1)}`
  const protocol = new LeucoCodexProtocol({
    writer: () => {},
    onLog: (text) => logs.push(text),
    logPreviewChars: 64,
  })
  protocol.feedChunk(`${line}\n`)
  expect(logs).toEqual([`[codex non-json] ${"x".repeat(prefix - 1)}${suffix}`])
})
it("does not redact valid protocol result values intended for the caller", async () => {
  const redactions: string[] = []
  const protocol = new LeucoCodexProtocol({
    writer: () => {},
    redactLogText: (line) => {
      redactions.push(line)
      return "[redacted]"
    },
  })
  const pending = protocol.request("probe")
  protocol.feedChunk('{"id":1,"result":{"value":"original"}}\n')
  await expect(pending).resolves.toEqual({ value: "original" })
  expect(redactions).toEqual([])
})

it("bounds and masks rejected server-request diagnostics while preserving the reply id", () => {
  const written: string[] = []
  const logs: string[] = []
  const secret = "private-approval-secret"
  const id = `approval\n\u001b[2J${secret}${"i".repeat(4000)}`
  const method = `exec\n\u001b[2J xoxb-synthetic-approval ${secret}${"m".repeat(4000)}`
  const protocol = new LeucoCodexProtocol({
    writer: (line) => written.push(line),
    onLog: (line) => logs.push(line),
    logPreviewChars: 128,
    redactLogText: (line) => line.split(secret).join("[redacted]"),
  })
  protocol.feedChunk(`${JSON.stringify({ jsonrpc: "2.0", id, method })}\n`)
  expect(logs).toHaveLength(1)
  expect(logs[0]!.length).toBeLessThanOrEqual("[codex server request rejected] ".length + 128)
  expect(logs[0]).not.toContain(secret)
  expect(logs[0]).not.toContain("\n")
  expect(logs[0]).not.toContain("\u001b")
  const reply = JSON.parse(written[0]!)
  expect(reply.id).toBe(id)
  expect(reply.error).toEqual({ code: -32601, message: "leuco cannot answer server requests" })
})

it("masks standard tokens in server-request diagnostics without an injected redactor", () => {
  const logs: string[] = []
  const protocol = new LeucoCodexProtocol({ writer: () => {}, onLog: (line) => logs.push(line) })
  protocol.feedChunk(
    `${JSON.stringify({ id: "xapp-synthetic-approval", method: "xoxb-synthetic-approval" })}\n`,
  )
  expect(logs[0]).not.toContain("synthetic")
  expect(logs[0]).toContain("[redacted]")
})

it("masks secrets before escaping their JSON control characters", () => {
  const secret = 'private-secret-"\n-tail'
  const logs: string[] = []
  const protocol = new LeucoCodexProtocol({
    writer: () => {},
    onLog: (line) => logs.push(line),
    redactLogText: (line) => line.split(secret).join("[redacted]"),
  })
  protocol.feedChunk(`${JSON.stringify({ id: secret, method: secret })}\n`)
  expect(logs).toEqual([
    '[codex server request rejected] {"method":"[redacted]","id":"[redacted]"}',
  ])
})
