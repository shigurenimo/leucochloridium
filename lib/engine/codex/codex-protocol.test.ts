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

  it("tolerates JSON that fails the schema", () => {
    const h = harness()
    expect(() => h.protocol.feedChunk(`{"unknown":"shape"}\n`)).not.toThrow()
  })

  it("tolerates non-JSON lines", () => {
    const h = harness()
    expect(() => h.protocol.feedChunk(`not json\n`)).not.toThrow()
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
