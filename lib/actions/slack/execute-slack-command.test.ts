import { afterEach, describe, expect, it, vi } from "vitest"
import { executeSlackCommand } from "@/actions/slack/execute-slack-command"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { fetchSlackFile } from "@/actions/slack/fetch-slack-file"
vi.mock("@/actions/slack/fetch-slack-file", () => ({ fetchSlackFile: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

describe("daemon Slack actions without local filesystem access", () => {
  it("uploads caller-provided bytes without reading the supplied path", async () => {
    const upload = vi
      .spyOn(LeucoFetchSlackWebClient.prototype, "filesUpload")
      .mockResolvedValue({ fileId: "F123" })
    const content = new TextEncoder().encode("provided bytes")
    const reply = await executeSlackCommand({
      botToken: "bot-secret",
      upload: content,
      parsed: {
        words: ["slack", "upload-file"],
        flags: { file: "/must/not/read/report.txt", channel: "C123" },
      },
    })
    expect(reply).toEqual({ fileId: "F123" })
    expect(upload).toHaveBeenCalledWith({
      content,
      filename: "report.txt",
      title: "report.txt",
      channelId: "C123",
      threadTs: null,
      initialComment: null,
    })
  })
  it("refuses a path-only upload request", async () => {
    await expect(
      executeSlackCommand({
        botToken: "bot-secret",
        parsed: {
          words: ["slack", "upload-file"],
          flags: { file: "/private/path", channel: "C123" },
        },
      }),
    ).rejects.toThrow("content is missing")
  })
  it("returns file bytes without writing the requested output path or forwarding upstream headers", async () => {
    vi.spyOn(LeucoFetchSlackWebClient.prototype, "apiCall").mockResolvedValue({
      ok: true,
      file: { url_private_download: "https://files.slack.com/file" },
    })
    vi.mocked(fetchSlackFile).mockResolvedValue(
      new Response("provided file", { headers: { authorization: "Bearer sensitive" } }),
    )
    const reply = await executeSlackCommand({
      botToken: "bot-secret",
      parsed: {
        words: ["slack", "download-file"],
        flags: { file: "F123", out: "/must/not/write/report.txt" },
      },
    })
    expect(reply).toBeInstanceOf(Response)
    if (!(reply instanceof Response)) throw new Error("Response expected")
    expect(await reply.text()).toBe("provided file")
    expect(reply.headers.get("authorization")).toBeNull()
    expect(fetchSlackFile).toHaveBeenCalledWith("https://files.slack.com/file", "bot-secret")
  })
})
