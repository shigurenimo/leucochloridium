import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchSlackFile } from "@/actions/slack/fetch-slack-file"
import { errorDetails } from "@/error-details"
import { MAX_TIMER_DELAY_MS } from "@/timer-limits"

describe("fetchSlackFile", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  it("returns the response directly when no redirect happens", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response("filebytes", { status: 200 }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t")

    expect(await response.text()).toBe("filebytes")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual")
  })

  it("follows a redirect to another slack host and re-sends the token", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).includes("edge.slack.com")) {
        return new Response("filebytes", { status: 200 })
      }
      return new Response(null, {
        status: 302,
        headers: { Location: "https://edge.slack.com/blob" },
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t")

    expect(await response.text()).toBe("filebytes")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.redirect).toBe("manual")
      expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer xoxb-t" })
    }
  })

  it("resolves a relative location against the current url", async () => {
    const seenUrls: string[] = []
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      seenUrls.push(String(url))
      if (seenUrls.length === 1) {
        return new Response(null, { status: 302, headers: { Location: "/moved/blob" } })
      }
      return new Response("filebytes", { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t")

    expect(seenUrls[1]).toBe("https://files.slack.com/moved/blob")
  })

  it("refuses a redirect to a non-slack host", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example.com/steal" },
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t"),
    ).rejects.toThrow("non-slack host")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("throws after more than 3 redirect hops", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://files.slack.com/again" },
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t"),
    ).rejects.toThrow("too many redirects")
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("throws on a redirect without a location header", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t"),
    ).rejects.toThrow("without location header")
  })

  it("aborts a stalled file request", async () => {
    globalThis.fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })
      },
    ) as unknown as typeof fetch

    await expect(
      fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t", 5),
    ).rejects.toThrow("slack file download timed out after 5ms")
  })
  it("keeps its timeout with an external signal even if fetch ignores abort", async () => {
    vi.useFakeTimers()
    const external = new AbortController()
    const fetchMock = vi.fn(async (): Promise<Response> => new Promise(() => {}))
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
    const observed: { failure: unknown } = { failure: null }
    const pending = fetchSlackFile(
      "https://files.slack.com/file",
      "xoxb-test",
      20,
      external.signal,
    ).catch((error: unknown) => {
      observed.failure = error
    })
    await vi.advanceTimersByTimeAsync(20)
    expect(String(observed.failure)).toContain("timed out after 20ms")
    await pending
    expect(external.signal.aborted).toBe(false)
  })
  it("uses one deadline across redirect hops", async () => {
    vi.useFakeTimers()
    const calls = { count: 0 }
    globalThis.fetch = Object.assign(
      vi.fn(async (): Promise<Response> => {
        calls.count += 1
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                calls.count === 1
                  ? new Response(null, { status: 302, headers: { location: "/next" } })
                  : new Response("file"),
              ),
            15,
          ),
        )
      }),
      { preconnect: originalFetch.preconnect },
    )
    const observed: { failure: unknown } = { failure: null }
    const pending = fetchSlackFile("https://files.slack.com/file", "xoxb-test", 20).catch(
      (error: unknown) => {
        observed.failure = error
      },
    )
    await vi.advanceTimersByTimeAsync(20)
    expect(String(observed.failure)).toContain("timed out after 20ms")
    await pending
    expect(calls.count).toBe(2)
  })
  it("does not follow a redirect when closing its body fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("redirect cleanup failed")
      },
    })
    const fetchMock = vi.fn(
      async () => new Response(body, { status: 302, headers: { location: "/next" } }),
    )
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
    await expect(fetchSlackFile("https://files.slack.com/file", "xoxb-test")).rejects.toThrow(
      "redirect cleanup failed",
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it("bounds redirect cleanup that never settles", async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(async (): Promise<void> => new Promise(() => {}))
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetchMock = vi.fn(async () => new Response(body, { status: 302 }))
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
    const observed: { failure: unknown } = { failure: null }
    const pending = fetchSlackFile("https://files.slack.com/file", "xoxb-test").catch(
      (error: unknown) => {
        observed.failure = error
      },
    )
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    const causes = errorDetails(observed.failure)
    expect(causes.some((cause) => cause.message.includes("without location header"))).toBe(true)
    expect(causes.some((cause) => cause.message.includes("cancellation timed out"))).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("keeps caller cancellation connected after handing off the final response", async () => {
    vi.useFakeTimers()
    const external = new AbortController()
    const signals: AbortSignal[] = []
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal)
      return new Response("file")
    })
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
    await fetchSlackFile("https://files.slack.com/file", "xoxb-test", 20, external.signal)
    expect(vi.getTimerCount()).toBe(0)
    external.abort(new Error("caller cancelled"))
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[0]?.reason.message).toBe("caller cancelled")
  })
  it("does not start a request after caller cancellation", async () => {
    const external = new AbortController()
    external.abort(new Error("caller cancelled"))
    const fetchMock = vi.fn(async () => new Response("file"))
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
    await expect(
      fetchSlackFile("https://files.slack.com/file", "xoxb-test", 20, external.signal),
    ).rejects.toThrow("caller cancelled")
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("preserves a redirect validation failure and failed cleanup together", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("redirect cleanup failed")
      },
    })
    const fetchMock = vi.fn(async () => new Response(body, { status: 302 }))
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
    const failure = await fetchSlackFile("https://files.slack.com/file", "xoxb-test").catch(
      (error: unknown) => error,
    )
    const causes = errorDetails(failure)
    expect(causes.some((cause) => cause.message.includes("without location header"))).toBe(true)
    expect(causes.some((cause) => cause.message.includes("redirect cleanup failed"))).toBe(true)
  })
})

it.each(["missing-location", "too-many"])(
  "omits URL query and fragment credentials from %s redirect failures",
  async (mode) => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers:
            mode === "too-many"
              ? { location: "/next?ticket=private-download-ticket#private-fragment" }
              : {},
        }),
    )
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
    try {
      const failure = await fetchSlackFile(
        "https://files.slack.com/file?ticket=private-download-ticket#private-fragment",
        "test",
      ).catch((error: unknown) => error)
      expect(String(failure)).toContain("https://files.slack.com/")
      expect(String(failure)).not.toContain("private-")
      expect(String(failure)).not.toContain("ticket=")
      expect(fetchMock).toHaveBeenCalledTimes(mode === "too-many" ? 4 : 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  },
)

it("uses safe malformed redirect diagnostics and still cancels the owned body", async () => {
  const originalFetch = globalThis.fetch
  const cancel = vi.fn(async () => {})
  const location = "https://user:private-password@[invalid"
  const fetchMock = vi.fn(
    async () =>
      new Response(new ReadableStream({ cancel }), { status: 302, headers: { location } }),
  )
  globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
  try {
    const failure = await fetchSlackFile("https://files.slack.com/file", "test").catch(
      (error: unknown) => error,
    )
    expect(String(failure)).toContain(`invalid download url (${location.length} characters)`)
    expect(String(failure)).not.toContain("private-")
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  } finally {
    globalThis.fetch = originalFetch
  }
})

it.each([MAX_TIMER_DELAY_MS + 1, Number.MAX_SAFE_INTEGER])(
  "rejects an overflowing Slack file timeout %s before sending",
  async (timeoutMs) => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async () => new Response("file"))
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
    try {
      await expect(
        fetchSlackFile("https://files.slack.com/file", "test", timeoutMs),
      ).rejects.toThrow(`between 1 and ${MAX_TIMER_DELAY_MS}`)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  },
)

it("accepts the maximum file timer and clears it after handing off the response", async () => {
  vi.useFakeTimers()
  const originalFetch = globalThis.fetch
  const fetchMock = vi.fn(async () => new Response("file"))
  globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
  try {
    const response = await fetchSlackFile(
      "https://files.slack.com/file",
      "test",
      MAX_TIMER_DELAY_MS,
    )
    expect(await response.text()).toBe("file")
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  }
})
