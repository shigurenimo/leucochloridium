import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { slackDownloadFile } from "@/actions/slack/slack-download-file"

describe("slackDownloadFile", () => {
  const originalFetch = globalThis.fetch
  const directories: string[] = []

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("streams into a private destination and reports its size", async () => {
    const directory = createDirectory(directories)
    const outputPath = join(directory, "nested", "file.txt")
    const encoder = new TextEncoder()
    const chunks = [encoder.encode("large "), encoder.encode("file")]
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift()
        if (chunk === undefined) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
      },
    })
    globalThis.fetch = mockFetch(() => new Response(body, { status: 200 }))

    const result = await slackDownloadFile({
      botToken: "xoxb-test",
      url: "https://files.slack.com/files-pri/T1-F1/download/file.txt",
      outputPath,
      maxBytes: 20,
    })

    expect(result).toEqual({ outputPath, size: 10 })
    expect(readFileSync(outputPath, "utf8")).toBe("large file")
    expect(statSync(outputPath).mode & 0o777).toBe(0o600)
  })

  it("keeps an existing destination when the declared size exceeds the cap", async () => {
    const directory = createDirectory(directories)
    const outputPath = join(directory, "file.txt")
    writeFileSync(outputPath, "original")
    globalThis.fetch = mockFetch(
      () => new Response("too-large", { headers: { "content-length": "9" } }),
    )

    await expect(
      slackDownloadFile({
        botToken: "xoxb-test",
        url: "https://files.slack.com/files-pri/T1-F1/download/file.txt",
        outputPath,
        maxBytes: 5,
      }),
    ).rejects.toThrow("download exceeds 5 byte limit")

    expect(readFileSync(outputPath, "utf8")).toBe("original")
    expect(readdirSync(directory)).toEqual(["file.txt"])
  })

  it("removes the partial file and preserves the destination when streaming fails", async () => {
    const directory = createDirectory(directories)
    const outputPath = join(directory, "file.txt")
    writeFileSync(outputPath, "original")
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"))
        controller.error(new Error("connection lost"))
      },
    })
    globalThis.fetch = mockFetch(() => new Response(body, { status: 200 }))

    await expect(
      slackDownloadFile({
        botToken: "xoxb-test",
        url: "https://files.slack.com/files-pri/T1-F1/download/file.txt",
        outputPath,
      }),
    ).rejects.toThrow("connection lost")

    expect(readFileSync(outputPath, "utf8")).toBe("original")
    expect(readdirSync(directory)).toEqual(["file.txt"])
  })

  it("keeps the hard deadline active while reading the body", async () => {
    const directory = createDirectory(directories)
    const outputPath = join(directory, "file.txt")
    writeFileSync(outputPath, "original")
    globalThis.fetch = mockFetch((_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"))
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")))
        },
      })
      return new Response(body)
    })

    await expect(
      slackDownloadFile({
        botToken: "xoxb-test",
        url: "https://files.slack.com/files-pri/T1-F1/download/file.txt",
        outputPath,
        timeoutMs: 20,
        idleTimeoutMs: 1_000,
      }),
    ).rejects.toThrow("slack file download timed out after 20ms")

    expect(readFileSync(outputPath, "utf8")).toBe("original")
    expect(readdirSync(directory)).toEqual(["file.txt"])
  })

  it("aborts fetch when no response arrives before the idle timeout", async () => {
    vi.useFakeTimers()
    const directory = createDirectory(directories)
    const outputPath = join(directory, "file.txt")
    writeFileSync(outputPath, "original")
    const fetchState: { signal?: AbortSignal } = {}
    globalThis.fetch = mockFetch((_input, init) => {
      fetchState.signal = init?.signal instanceof AbortSignal ? init.signal : undefined
      return new Promise<Response>(() => {})
    })

    const download = slackDownloadFile({
      botToken: "xoxb-test",
      url: "https://files.slack.com/files-pri/T1-F1/download/file.txt",
      outputPath,
      timeoutMs: 1_000,
      idleTimeoutMs: 20,
    })
    const rejection = expect(download).rejects.toThrow("download timed out after 20ms without data")

    await vi.advanceTimersByTimeAsync(20)
    await rejection

    expect(fetchState.signal?.aborted).toBe(true)
    expect(readFileSync(outputPath, "utf8")).toBe("original")
    expect(readdirSync(directory)).toEqual(["file.txt"])
  })

  it("renews the idle timeout for each chunk and cancels a stalled reader", async () => {
    vi.useFakeTimers()
    const directory = createDirectory(directories)
    const outputPath = join(directory, "file.txt")
    writeFileSync(outputPath, "original")
    const encoder = new TextEncoder()
    const cancel = vi.fn()
    const pulls = { count: 0 }
    const secondPull = Promise.withResolvers<void>()
    const thirdPull = Promise.withResolvers<void>()
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls.count += 1
          if (pulls.count === 1) {
            controller.enqueue(encoder.encode("first"))
            return
          }
          if (pulls.count === 2) {
            secondPull.resolve()
            setTimeout(() => controller.enqueue(encoder.encode("second")), 15)
            return
          }
          thirdPull.resolve()
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
    const fetchState: { signal?: AbortSignal } = {}
    globalThis.fetch = mockFetch((_input, init) => {
      fetchState.signal = init?.signal instanceof AbortSignal ? init.signal : undefined
      return new Response(body, { status: 200 })
    })

    const download = slackDownloadFile({
      botToken: "xoxb-test",
      url: "https://files.slack.com/files-pri/T1-F1/download/file.txt",
      outputPath,
      timeoutMs: 1_000,
      idleTimeoutMs: 20,
    })
    const rejection = expect(download).rejects.toThrow("download timed out after 20ms without data")

    await secondPull.promise
    await vi.advanceTimersByTimeAsync(15)
    await thirdPull.promise
    await vi.advanceTimersByTimeAsync(19)
    expect(cancel).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await rejection

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetchState.signal?.aborted).toBe(true)
    expect(readFileSync(outputPath, "utf8")).toBe("original")
    expect(readdirSync(directory)).toEqual(["file.txt"])
  })
})

const createDirectory = (directories: string[]): string => {
  const directory = mkdtempSync(join(tmpdir(), "leuco-slack-download-"))
  directories.push(directory)
  return directory
}

const mockFetch = (
  response: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch => {
  return Object.assign(
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => response(input, init)),
    { preconnect: globalThis.fetch.preconnect },
  )
}
