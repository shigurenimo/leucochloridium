import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { slackDownloadFile } from "@/actions/slack/slack-download-file"

describe("slackDownloadFile", () => {
  const originalFetch = globalThis.fetch
  let dir = ""

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leuco-download-"))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  it("streams the response into a private output file", async () => {
    globalThis.fetch = vi.fn(async () => new Response("filebytes")) as unknown as typeof fetch
    const outputPath = join(dir, "out.bin")

    const result = await slackDownloadFile({
      botToken: "xoxb-test",
      url: "https://files.slack.com/file",
      outputPath,
      maxBytes: 20,
    })

    expect(result).toEqual({ outputPath, size: 9 })
    expect(readFileSync(outputPath, "utf8")).toBe("filebytes")
    expect(statSync(outputPath).mode & 0o777).toBe(0o600)
  })

  it("keeps an existing output intact when the size limit is exceeded", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("too-large", { headers: { "Content-Length": "9" } }),
    ) as unknown as typeof fetch
    const outputPath = join(dir, "out.bin")
    writeFileSync(outputPath, "original")

    await expect(
      slackDownloadFile({
        botToken: "xoxb-test",
        url: "https://files.slack.com/file",
        outputPath,
        maxBytes: 5,
      }),
    ).rejects.toThrow("download exceeds 5 byte limit")

    expect(readFileSync(outputPath, "utf8")).toBe("original")
    expect(readdirSync(dir)).toEqual(["out.bin"])
    expect(existsSync(outputPath)).toBe(true)
  })

  it("times out a stalled response body without replacing the output", async () => {
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"))
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")))
        },
      })
      return new Response(body)
    }) as unknown as typeof fetch
    const outputPath = join(dir, "out.bin")
    writeFileSync(outputPath, "original")

    await expect(
      slackDownloadFile({
        botToken: "xoxb-test",
        url: "https://files.slack.com/file",
        outputPath,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("slack file download timed out after 5ms")

    expect(readFileSync(outputPath, "utf8")).toBe("original")
    expect(readdirSync(dir)).toEqual(["out.bin"])
  })
})
