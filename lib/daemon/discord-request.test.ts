import { describe, expect, it, vi } from "vitest"
import { handleDaemonRequest } from "@/daemon/handle-daemon-request"

function fixture(ready = true) {
  const runDiscordCommand = vi.fn(
    async (_parsed: unknown, _requestId: string): Promise<unknown> => ({ id: "1" }),
  )
  const handler = handleDaemonRequest({
    token: "control",
    cwd: "/work",
    isReady: () => ready,
    runTextTurn: async () => "",
    stop: () => {},
    runDiscordCommand,
  })
  const request = (words: string[], token = "control") =>
    handler(
      new Request("http://localhost/discord", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ words, flags: {} }),
      }),
    )
  return { runDiscordCommand, request }
}
describe("Discord daemon proxy", () => {
  it("requires authenticated control and forwards only validated API operations", async () => {
    const test = fixture()
    expect((await test.request(["discord", "call", "GET", "/users/@me"], "wrong")).status).toBe(401)
    expect((await test.request(["discord", "login"])).status).toBe(422)
    expect((await test.request(["slack", "call", "auth.test"])).status).toBe(422)
    expect(test.runDiscordCommand).not.toHaveBeenCalled()
    expect(await (await test.request(["discord", "call", "GET", "/users/@me"])).json()).toEqual({
      id: "1",
    })
    expect(test.runDiscordCommand).toHaveBeenCalledOnce()
  })
  it("does not expose upstream errors or run while stopping", async () => {
    const test = fixture()
    test.runDiscordCommand.mockRejectedValueOnce(new Error("private-token"))
    expect(
      await (await test.request(["discord", "call", "GET", "/users/@me"])).text(),
    ).not.toContain("private-token")
    const stopped = fixture(false)
    expect((await stopped.request(["discord", "call", "GET", "/users/@me"])).status).toBe(503)
    expect(stopped.runDiscordCommand).not.toHaveBeenCalled()
  })
})
