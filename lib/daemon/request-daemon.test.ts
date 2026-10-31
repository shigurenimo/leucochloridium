import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { handleDaemonRequest } from "@/daemon/handle-daemon-request"
import { CliError } from "@/cli/cli-error"
import { daemonErrorResponse } from "@/daemon/daemon-error-response"
import { requestDaemon } from "@/daemon/request-daemon"
import { errorDetails } from "@/error-details"
import { DaemonHttpRequest, type DaemonRequest } from "@/daemon/daemon-http-request"
import { readDaemonLease } from "@/daemon/daemon-lease"

vi.mock("@/daemon/daemon-lease", () => ({
  readDaemonLease: vi.fn(() => ({ pid: 42, token: "synthetic-control-token" })),
}))
const originalFetch = globalThis.fetch
beforeEach(() => {
  vi.mocked(readDaemonLease)
    .mockReset()
    .mockReturnValue({ pid: 42, token: "synthetic-control-token" })
})
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
})

it("does not expose the control token echoed in JSON error details", async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async () =>
      Response.json(
        { error: "Bearer synthetic-control-token", debug: { echo: "synthetic-control-token" } },
        { status: 503 },
      ),
    ),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({ home: "/memory", path: "/turn" }).catch(
    (error: unknown) => error,
  )
  expect(JSON.stringify({ failure, causes: errorDetails(failure) })).not.toContain(
    "synthetic-control-token",
  )
  expect(failure).toMatchObject({ code: "STATE_UNCERTAIN", details: { status: 503 } })
})

it("masks transport causes without discarding OS codes", async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async (): Promise<Response> => {
      throw Object.assign(new Error("Authorization: Bearer synthetic-control-token"), {
        code: "EACCES",
        cause: new Error("cleanup synthetic-control-token"),
      })
    }),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({ home: "/memory", path: "/turn" }).catch(
    (error: unknown) => error,
  )
  const causes = errorDetails(failure)
  expect(JSON.stringify({ failure, causes })).not.toContain("synthetic-control-token")
  expect(causes.some((cause) => cause.code === "EACCES")).toBe(true)
})

it("masks accidental control-token echoes in successful JSON results", async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async () => Response.json({ echo: "Bearer synthetic-control-token" })),
    { preconnect: originalFetch.preconnect },
  )
  expect(await requestDaemon({ home: "/memory", path: "/turn" })).toEqual({
    echo: "Bearer [redacted]",
  })
})

it("rejects status from a different PID than the authenticated lease", async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async () => Response.json({ running: true, ready: true, pid: 43, cwd: "/work" })),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({ home: "/memory", path: "/status" }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "identity", expectedPid: 42, reportedPid: 43 },
  })
})

it("does not trust status when ownership changes during the request", async () => {
  vi.mocked(readDaemonLease)
    .mockReturnValueOnce({ pid: 42, token: "synthetic-control-token" })
    .mockReturnValueOnce({ pid: 42, token: "replacement-control-token" })
  globalThis.fetch = Object.assign(
    vi.fn(async () => Response.json({ running: true, ready: true, pid: 42, cwd: "/work" })),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({ home: "/memory", path: "/status" }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ code: "STATE_CONFLICT", details: { phase: "identity" } })
  expect(JSON.stringify(failure)).not.toContain("control-token")
})

it("does not accept a stopped status from a live control connection", async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async () => Response.json({ running: false })),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({ home: "/memory", path: "/status" }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ code: "STATE_UNCERTAIN", details: { phase: "status" } })
})

it("rejects status when ownership disappears before the response is verified", async () => {
  vi.mocked(readDaemonLease)
    .mockReturnValueOnce({ pid: 42, token: "synthetic-control-token" })
    .mockReturnValueOnce(null)
  globalThis.fetch = Object.assign(
    vi.fn(async () => Response.json({ running: true, ready: true, pid: 42, cwd: "/work" })),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({ home: "/memory", path: "/status" }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({
    code: "STATE_CONFLICT",
    details: { phase: "identity", currentPid: null },
  })
})

it("retains the filesystem cause when ownership cannot be reread", async () => {
  vi.mocked(readDaemonLease)
    .mockReturnValueOnce({ pid: 42, token: "synthetic-control-token" })
    .mockImplementationOnce(() => {
      throw Object.assign(new Error("lease unreadable"), { code: "EACCES" })
    })
  globalThis.fetch = Object.assign(
    vi.fn(async () => Response.json({ running: true, ready: true, pid: 42, cwd: "/work" })),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({ home: "/memory", path: "/status" }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ code: "STATE_UNCERTAIN", details: { phase: "identity" } })
  expect(errorDetails(failure).some((cause) => cause.code === "EACCES")).toBe(true)
})

it("retains size-limit and cleanup failures together", async () => {
  vi.useFakeTimers()
  globalThis.fetch = Object.assign(
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async cancel(): Promise<void> {
              return new Promise(() => {})
            },
          }),
          { headers: { "content-length": String(16 * 1024 * 1024 + 1) } },
        ),
    ),
    { preconnect: originalFetch.preconnect },
  )
  const pending = requestDaemon({ home: "/memory", path: "/status" }).catch(
    (error: unknown) => error,
  )
  await vi.advanceTimersByTimeAsync(1000)
  const causes = errorDetails(await pending)
  expect(causes.some((cause) => cause.message.includes("exceeded"))).toBe(true)
  expect(causes.some((cause) => cause.message.includes("cancellation timed out"))).toBe(true)
})

it("cannot replay a request by reusing the same owner", async () => {
  const fetchMock = vi.fn(async () => Response.json({ ok: true }))
  globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
  const request = new DaemonHttpRequest({ home: "/memory", path: "/turn", body: { text: "work" } })
  await request.getJson()
  await expect(request.getJson()).rejects.toThrow("only run once")
  expect(fetchMock).toHaveBeenCalledOnce()
})

it("preserves HTTP status and JSON parsing causes for non-JSON daemon errors", async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async () => new Response("service unavailable", { status: 503 })),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({ home: "/memory", path: "/status" }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ code: "STATE_UNCERTAIN", details: { status: 503 } })
  expect(errorDetails(failure).some((cause) => cause.name === "SyntaxError")).toBe(true)
})

it("rejects oversized daemon JSON instead of reporting a successful result", async () => {
  globalThis.fetch = Object.assign(
    vi.fn(
      async () =>
        new Response("{}", {
          headers: { "content-length": String(16 * 1024 * 1024 + 1) },
        }),
    ),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({ home: "/memory", path: "/status" }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ code: "STATE_UNCERTAIN", details: { status: 200 } })
})

it("cancels reading a body that ignores the caller signal", async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const cancel = vi.fn()
  globalThis.fetch = Object.assign(
    vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }))),
    { preconnect: originalFetch.preconnect },
  )
  const observed: { failure: unknown } = { failure: null }
  const pending = requestDaemon({
    home: "/memory",
    path: "/status",
    signal: controller.signal,
  }).catch((error: unknown) => {
    observed.failure = error
  })
  await vi.advanceTimersByTimeAsync(0)
  controller.abort(new Error("caller cancelled"))
  await vi.advanceTimersByTimeAsync(0)
  expect(errorDetails(observed.failure).some((cause) => cause.message === "caller cancelled")).toBe(
    true,
  )
  await pending
  expect(cancel).toHaveBeenCalledOnce()
})

it("keeps a classified daemon uncertainty and original details without retrying", async () => {
  const fetch = vi.fn(async () =>
    Response.json(
      {
        error: "worker publication unconfirmed",
        requestId: "publication-request",
        failure: {
          schemaVersion: 1,
          code: "STATE_UNCERTAIN",
          details: { phase: "worker-publication", journalWritten: true, workerPid: 42 },
          causes: [{ name: "Error", message: "publication denied", stack: null, code: "EACCES" }],
        },
      },
      { status: 422 },
    ),
  )
  globalThis.fetch = Object.assign(fetch, { preconnect: originalFetch.preconnect })
  const failure = await requestDaemon({
    home: "/memory",
    path: "/restart",
    body: {},
    requestId: "publication-request",
  }).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: {
      phase: "worker-publication",
      journalWritten: true,
      workerPid: 42,
      causes: expect.arrayContaining([expect.objectContaining({ code: "EACCES" })]),
    },
  })
  expect(errorDetails(failure)).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "EACCES" })]),
  )
  expect(fetch).toHaveBeenCalledOnce()
})

it("does not trust classified failure metadata from a different request", async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async () =>
      Response.json(
        {
          error: "validation failed",
          requestId: "wrong-request",
          failure: { schemaVersion: 1, code: "USAGE", details: null, causes: [] },
        },
        { status: 422 },
      ),
    ),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({
    home: "/memory",
    path: "/restart",
    body: {},
    requestId: "expected-request",
  }).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: {
      phase: "error-identity",
      expectedRequestId: "expected-request",
      actualRequestId: "wrong-request",
    },
  })
})
it("keeps legacy handling when a daemon supplies an unknown error protocol", async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async () =>
      Response.json(
        {
          error: "legacy diagnostic",
          requestId: "request",
          failure: { schemaVersion: 999, code: "USAGE", details: null, causes: [] },
        },
        { status: 422 },
      ),
    ),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({
    home: "/memory",
    path: "/restart",
    body: {},
    requestId: "request",
  }).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: "OPERATION_FAILED",
    message: "legacy diagnostic",
    details: { status: 422 },
  })
})

it("keeps safe diagnostic causes when original remote metadata cannot be serialized", async () => {
  const details: { cycle?: unknown } = {}
  details.cycle = details
  const original = new CliError("STATE_UNCERTAIN", "accepted but unconfirmed", details)
  original.cause = Object.assign(new Error("publication denied synthetic-control-token"), {
    code: "EIO",
  })
  globalThis.fetch = Object.assign(
    vi.fn(async () =>
      daemonErrorResponse({
        error: original,
        status: 422,
        requestId: "request",
        redactionSecrets: ["synthetic-control-token"],
      }),
    ),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({
    home: "/memory",
    path: "/restart",
    body: {},
    requestId: "request",
  }).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: {
      phase: "daemon-error-details",
      originalDetailsAvailable: false,
      causes: expect.arrayContaining([expect.objectContaining({ code: "EIO" })]),
    },
  })
  expect(JSON.stringify({ failure, causes: errorDetails(failure) })).not.toContain(
    "synthetic-control-token",
  )
})

it.each([null, "original diagnostic", ["original", "values"]])(
  "retains non-object remote details alongside causes (%j)",
  async (details) => {
    const original = new CliError("STATE_UNCERTAIN", "unconfirmed", details)
    globalThis.fetch = Object.assign(
      vi.fn(async () =>
        daemonErrorResponse({ error: original, status: 422, requestId: "request" }),
      ),
      { preconnect: originalFetch.preconnect },
    )
    const failure = await requestDaemon({
      home: "/memory",
      path: "/restart",
      body: {},
      requestId: "request",
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: "STATE_UNCERTAIN",
      details: { originalDetails: details, causes: expect.any(Array) },
    })
  },
)

it.each([401, 503, 422, 500])(
  "keeps execution uncertain when HTTP %s has an unreadable error body",
  async (status) => {
    const fetch = vi.fn(async () => new Response("invalid JSON", { status }))
    globalThis.fetch = Object.assign(fetch, { preconnect: originalFetch.preconnect })
    const failure = await requestDaemon({
      home: "/memory",
      path: "/restart",
      body: {},
      requestId: "request",
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: "STATE_UNCERTAIN",
      details: { phase: "error-body", status },
    })
    expect(fetch).toHaveBeenCalledOnce()
  },
)

it("does not infer pre-execution refusal from a 503 after the operation callback ran", async () => {
  const runSlackCommand = vi.fn(async () =>
    Response.json({ error: "injected service error after acceptance" }, { status: 503 }),
  )
  const handler = handleDaemonRequest({
    token: "synthetic-control-token",
    cwd: "/memory",
    isReady: () => true,
    runTextTurn: async () => "unused",
    stop: () => {},
    runSlackCommand,
  })
  const fetch = vi.fn(async (url: unknown, options?: RequestInit) =>
    handler(new Request(String(url), options)),
  )
  globalThis.fetch = Object.assign(fetch, { preconnect: originalFetch.preconnect })
  const failure = await requestDaemon({
    home: "/memory",
    path: "/slack",
    body: { words: ["slack", "call", "auth.test"], flags: { body: "{}" } },
    requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
  }).catch((error: unknown) => error)
  expect(runSlackCommand).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledOnce()
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "error-classification", status: 503 },
  })
})

it.each(["authorization", "readiness", "availability"])(
  "keeps a correlated pre-execution %s rejection classified",
  async (phase) => {
    const runTextTurn = vi.fn(async () => "never called")
    const handler = handleDaemonRequest({
      token: phase === "authorization" ? "different-token" : "synthetic-control-token",
      cwd: "/memory",
      isReady: () => phase !== "readiness",
      runTextTurn,
      stop: () => {},
    })
    globalThis.fetch = Object.assign(
      vi.fn(async (url: unknown, options?: RequestInit) =>
        handler(new Request(String(url), options)),
      ),
      { preconnect: originalFetch.preconnect },
    )
    const failure = await requestDaemon({
      home: "/memory",
      path: phase === "availability" ? "/restart" : "/turn",
      body: { text: "never execute" },
      requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: "STATE_CONFLICT",
      details: { phase, executionStarted: false, causes: [] },
    })
    expect(runTextTurn).not.toHaveBeenCalled()
  },
)

it.each([
  { details: null, possible: true },
  { details: { mutationMayHaveOccurred: false }, possible: true },
  { details: { executionStarted: false }, possible: false },
  { details: { executionStarted: false, operationCompleted: true }, possible: true },
])("does not infer unchanged state from a forwarded error code (%j)", async (probe) => {
  const fetch = vi.fn(async () =>
    Response.json(
      {
        error: "conflict",
        requestId: "request",
        failure: { schemaVersion: 1, code: "STATE_CONFLICT", details: probe.details, causes: [] },
      },
      { status: 422 },
    ),
  )
  globalThis.fetch = Object.assign(fetch, { preconnect: originalFetch.preconnect })
  const failure = await requestDaemon({
    home: "/memory",
    path: "/restart",
    body: {},
    requestId: "request",
  }).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: "STATE_CONFLICT",
    details: { mutationMayHaveOccurred: probe.possible },
  })
  expect(fetch).toHaveBeenCalledOnce()
})

it("reports transport route, budget and elapsed time without query values or credentials", async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async (): Promise<Response> => {
      throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" })
    }),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({
    home: "/memory",
    path: "/events?requestId=private-query-value",
    timeoutMs: 200,
  }).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: {
      phase: "transport",
      request: {
        method: "GET",
        path: "/events",
        leasePid: 42,
        timeoutMs: 200,
        elapsedMs: expect.any(Number),
        aborted: false,
        callerAborted: false,
      },
    },
  })
  expect(errorDetails(failure)[0]?.message).toContain("GET /events")
  expect(errorDetails(failure)[0]?.message).toContain("budget=200ms")
  expect(JSON.stringify({ failure, causes: errorDetails(failure) })).not.toMatch(
    /private-query-value|synthetic-control-token/,
  )
})
it("reports an inherited caller deadline as unknown rather than the default timeout", async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async () => new Response("invalid JSON")),
    { preconnect: originalFetch.preconnect },
  )
  const failure = await requestDaemon({
    home: "/memory",
    path: "/turn",
    body: { password: "synthetic-private-body" },
    signal: new AbortController().signal,
  }).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: {
      phase: "body",
      request: {
        method: "POST",
        path: "/turn",
        leasePid: 42,
        timeoutMs: null,
        elapsedMs: expect.any(Number),
        aborted: false,
        callerAborted: false,
      },
    },
  })
  expect(errorDetails(failure)[0]?.message).toContain("budget=caller signal")
  expect(JSON.stringify(failure)).not.toContain("synthetic-private-body")
})
it("distinguishes caller cancellation from an internal request budget", async () => {
  const controller = new AbortController()
  globalThis.fetch = Object.assign(
    vi.fn(() => new Promise<Response>(() => {})),
    { preconnect: originalFetch.preconnect },
  )
  const pending = requestDaemon({
    home: "/memory",
    path: "/status",
    signal: controller.signal,
  }).catch((error: unknown) => error)
  controller.abort(new Error("caller stopped observation"))
  const failure = await pending
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: {
      phase: "transport",
      request: { timeoutMs: null, aborted: true, callerAborted: true },
    },
  })
  expect(
    errorDetails(failure).some((cause) => cause.message === "caller stopped observation"),
  ).toBe(true)
})

it("retains status ownership verification when caller routing options change in flight", async () => {
  const response = Promise.withResolvers<Response>()
  globalThis.fetch = Object.assign(
    vi.fn(() => response.promise),
    { preconnect: originalFetch.preconnect },
  )
  const options: DaemonRequest = { home: "/memory", path: "/status" }
  const pending = requestDaemon(options).catch((error: unknown) => error)
  options.path = "/turn"
  options.home = "/other-home"
  response.resolve(Response.json({ running: true, ready: true, pid: 43, cwd: "/work" }))
  const failure = await pending
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "identity", expectedPid: 42, reportedPid: 43 },
  })
})
it("keeps the original budget, method and caller signal in failure diagnostics", async () => {
  const controller = new AbortController()
  globalThis.fetch = Object.assign(
    vi.fn(() => new Promise<Response>(() => {})),
    { preconnect: originalFetch.preconnect },
  )
  const options: DaemonRequest = {
    home: "/memory",
    path: "/status",
    timeoutMs: 200,
    signal: controller.signal,
  }
  const pending = requestDaemon(options).catch((error: unknown) => error)
  options.path = "/slack"
  options.body = { text: "synthetic changed body" }
  options.timeoutMs = 9999
  options.signal = new AbortController().signal
  controller.abort(new Error("original caller cancelled"))
  const failure = await pending
  expect(failure).toMatchObject({
    details: {
      phase: "transport",
      request: {
        method: "GET",
        path: "/status",
        timeoutMs: 200,
        aborted: true,
        callerAborted: true,
      },
    },
  })
})
it("captures the expected owner independently when the caller later edits its lease object", async () => {
  const expected = { pid: 42, token: "synthetic-control-token" }
  globalThis.fetch = Object.assign(
    vi.fn(async () => Response.json({ running: true, ready: true, pid: 42, cwd: "/work" })),
    { preconnect: originalFetch.preconnect },
  )
  const request = new DaemonHttpRequest({
    home: "/memory",
    path: "/status",
    expectedLease: expected,
  })
  expected.pid = 43
  expected.token = "replacement-token"
  await expect(request.getJson()).resolves.toMatchObject({ running: true, pid: 42 })
  expect(expected).toEqual({ pid: 43, token: "replacement-token" })
})
