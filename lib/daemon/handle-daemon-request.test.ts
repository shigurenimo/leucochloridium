import { describe, expect, it, vi } from "vitest"
import { handleDaemonRequest } from "@/daemon/handle-daemon-request"

function fixture() {
  const runTextTurn = vi.fn(async (_key: string, _text: string): Promise<string | Error> => "reply")
  const stop = vi.fn()
  const handler = handleDaemonRequest({
    token: "secret",
    cwd: "/work",
    isReady: () => true,
    runTextTurn,
    stop,
  })
  const request = (path: string, body?: unknown, token = "secret") =>
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
  it("reports failure without inventing a successful reply", async () => {
    const test = fixture()
    test.runTextTurn.mockResolvedValueOnce(new Error("permission denied"))
    expect((await test.request("/turn", { text: "work" })).status).toBe(422)
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
    const handler = handleDaemonRequest({
      token: "secret",
      cwd: "/work",
      isReady: () => true,
      runTextTurn: async () => "",
      stop: () => {},
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
