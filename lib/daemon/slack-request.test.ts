import { describe, expect, it, vi } from "vitest"
import { handleDaemonRequest } from "@/daemon/handle-daemon-request"

function fixture() {
  const runSlackCommand = vi.fn(
    async (_parsed: unknown, _upload?: Uint8Array): Promise<unknown> => ({ ok: true }),
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
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
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
    expect(test.runSlackCommand).toHaveBeenCalledWith(command, undefined)
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
        headers: { authorization: "Bearer control-secret" },
        body: multipart,
      }),
    )
    expect(response.status).toBe(200)
    expect(test.runSlackCommand).toHaveBeenCalledWith(parsed, new TextEncoder().encode("content"))
  })
})
