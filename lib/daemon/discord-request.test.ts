import { describe, expect, it, vi } from "vitest"
import { createMemoryDaemonHandler } from "@/daemon/memory-daemon-handler"

function fixture(ready = true) {
  const runDiscordCommand = vi.fn(
    async (_parsed: unknown, _requestId: string): Promise<unknown> => ({ id: "1" }),
  )
  const daemon = createMemoryDaemonHandler({
    token: "control",
    secrets: ["private-token"],
    overrides: { isReady: () => ready, runDiscordCommand },
  })
  const log = daemon.log
  const handler = daemon.handler
  const request = (words: string[], token = "control") =>
    handler(
      new Request("http://localhost/discord", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-leuco-request-id": "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
        },
        body: JSON.stringify({ words, flags: {} }),
      }),
    )
  return { log, runDiscordCommand, request }
}
describe("Discord daemon proxy", () => {
  it("requires authenticated control and forwards only validated API operations", async () => {
    const test = fixture()
    expect((await test.request(["discord", "call", "GET", "/users/@me"], "wrong")).status).toBe(401)
    expect((await test.request(["discord", "login"])).status).toBe(400)
    expect((await test.request(["slack", "call", "auth.test"])).status).toBe(400)
    expect(test.runDiscordCommand).not.toHaveBeenCalled()
    expect(await (await test.request(["discord", "call", "GET", "/users/@me"])).json()).toEqual({
      id: "1",
    })
    expect(test.runDiscordCommand).toHaveBeenCalledOnce()
  })
  it("masks known secrets in upstream errors and does not run while stopping", async () => {
    const test = fixture()
    test.runDiscordCommand.mockRejectedValueOnce(new Error("Discord rejected private-token"))
    const response = await test.request(["discord", "call", "GET", "/users/@me"])
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: "Discord rejected [redacted]",
      requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
    })
    expect(JSON.stringify(test.log.query())).not.toContain("private-token")
    expect(test.log.query()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          level: "error",
          requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
        }),
      }),
    ])
    const stopped = fixture(false)
    expect((await stopped.request(["discord", "call", "GET", "/users/@me"])).status).toBe(503)
    expect(stopped.runDiscordCommand).not.toHaveBeenCalled()
  })
})
