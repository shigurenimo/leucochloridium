import { describe, expect, it, vi } from "vitest"
import { handleDaemonRequest } from "@/daemon/handle-daemon-request"
import type { SlackCommandOptions } from "@/runtime/slack-command-options"

function fixture() {
  const runSlackCommand = vi.fn(
    async (_parsed: unknown, _options?: SlackCommandOptions): Promise<unknown> => ({ ok: true }),
  )
  const handler = handleDaemonRequest({
    token: "control-secret",
    cwd: "/work",
    isReady: () => true,
    runTextTurn: async () => "",
    stop: () => {},
    runSlackCommand,
  })
  const request = (body: unknown, token = "control-secret") =>
    handler(
      new Request("http://localhost/slack", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-leuco-request-id": "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
        },
        body: JSON.stringify(body),
      }),
    )
  return { handler, runSlackCommand, request }
}
const command = { words: ["slack", "call", "auth.test"], flags: { body: "{}" } }
describe("authenticated Slack proxy", () => {
  it("rejects unauthenticated requests without executing Slack", async () => {
    const test = fixture()
    expect((await test.request(command, "wrong")).status).toBe(401)
    expect(test.runSlackCommand).not.toHaveBeenCalled()
  })
  it("forwards explicit actions and suppresses sensitive backend exceptions", async () => {
    const test = fixture()
    expect(await (await test.request(command)).json()).toEqual({ ok: true })
    expect(test.runSlackCommand).toHaveBeenCalledWith(command, {
      upload: undefined,
      requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
      signal: expect.any(AbortSignal),
    })
    test.runSlackCommand.mockRejectedValueOnce(new Error("raw-bot-secret"))
    const response = await test.request(command)
    expect(response.status).toBe(422)
    expect(await response.text()).not.toContain("raw-bot-secret")
  })
  it.each([["slack", "login"], ["slack", "logout"], ["stop"]])(
    "does not expose credential management or other daemon commands %j",
    async (...words) => {
      const test = fixture()
      expect((await test.request({ words, flags: {} })).status).toBe(422)
      expect(test.runSlackCommand).not.toHaveBeenCalled()
    },
  )
  it("accepts file bytes supplied by the caller as multipart data", async () => {
    const test = fixture()
    const multipart = new FormData()
    const parsed = {
      words: ["slack", "upload-file"],
      flags: { file: "report.txt", channel: "C123" },
    }
    multipart.set("command", JSON.stringify(parsed))
    multipart.set("file", new Blob(["content"]), "report.txt")
    const response = await test.handler(
      new Request("http://localhost/slack", {
        method: "POST",
        headers: {
          authorization: "Bearer control-secret",
          "x-leuco-request-id": "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
        },
        body: multipart,
      }),
    )
    expect(response.status).toBe(200)
    expect(test.runSlackCommand).toHaveBeenCalledWith(parsed, {
      upload: new TextEncoder().encode("content"),
      requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
      signal: expect.any(AbortSignal),
    })
  })
  it("returns the safe original reason and correlation ID when the daemon supplies a reporter", async () => {
    const reportError = vi.fn(
      (_error: unknown, _requestId: string) => "Slack API chat.postMessage: missing_scope",
    )
    const handler = handleDaemonRequest({
      token: "control-secret",
      cwd: "/work",
      isReady: () => true,
      runTextTurn: async () => "",
      stop: () => {},
      runSlackCommand: async () => {
        throw new Error("raw-secret")
      },
      reportError,
    })
    const response = await handler(
      new Request("http://localhost/slack", {
        method: "POST",
        headers: {
          authorization: "Bearer control-secret",
          "content-type": "application/json",
          "x-leuco-request-id": "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
        },
        body: JSON.stringify(command),
      }),
    )
    expect(await response.json()).toEqual({
      error: "Slack API chat.postMessage: missing_scope",
      requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
    })
    expect(reportError).toHaveBeenCalledOnce()
  })
})
