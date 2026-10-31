import { expect, it } from "vitest"
import { z } from "zod"
import { CliError } from "@/cli/cli-error"
import { daemonErrorResponse } from "@/daemon/daemon-error-response"

it("marks shortened control errors without splitting Unicode or exposing tokens", async () => {
  const response = daemonErrorResponse({
    error: new Error(`xoxb-private-token ${"a".repeat(3976)}😀${"z".repeat(100)}`),
    status: 500,
    requestId: "control-request",
  })
  const body = z.object({ error: z.string(), requestId: z.string() }).parse(await response.json())
  expect(response.status).toBe(500)
  expect(body.requestId).toBe("control-request")
  expect(body.error).toHaveLength(3999)
  expect(body.error.endsWith(" [truncated]")).toBe(true)
  expect(body.error.isWellFormed()).toBe(true)
  expect(body.error).not.toContain("private-token")
})

it("preserves a classified uncertainty and its publication details across the daemon boundary", async () => {
  const response = daemonErrorResponse({
    error: new CliError("STATE_UNCERTAIN", "worker publication unconfirmed", {
      phase: "worker-publication",
      operationId: "operation",
      workerPid: 42,
      journalWritten: true,
    }),
    status: 422,
    requestId: "publication-request",
  })
  expect(await response.json()).toMatchObject({
    error: "worker publication unconfirmed",
    requestId: "publication-request",
    failure: {
      schemaVersion: 1,
      code: "STATE_UNCERTAIN",
      details: { phase: "worker-publication", journalWritten: true, workerPid: 42 },
    },
  })
})

it("masks known secrets in classified metadata before returning it", async () => {
  const secret = 'control"private\\\nvalue'
  const response = daemonErrorResponse({
    error: new CliError("STATE_UNCERTAIN", `unknown ${secret}`, {
      phase: "publication",
      [secret]: secret,
    }),
    redactionSecrets: [secret],
    status: 422,
    requestId: "request",
  })
  expect(await response.json()).toMatchObject({
    error: "unknown [redacted]",
    failure: { details: { phase: "publication", "[redacted]": "[redacted]" } },
  })
})
it.each(["cyclic", "oversized", "getter"])(
  "retains classification when metadata is %s",
  async (kind) => {
    const details: { reference?: unknown; text?: string } = {}
    if (kind === "cyclic") details.reference = details
    if (kind === "oversized") details.text = "x".repeat(70000)
    const failure = new CliError("STATE_UNCERTAIN", "accepted but unconfirmed", details)
    if (kind === "getter")
      Object.defineProperty(failure, "details", {
        get() {
          throw new Error("metadata unreadable")
        },
      })
    const response = daemonErrorResponse({ error: failure, status: 422, requestId: "request" })
    const body = await response.json()
    expect(body).toMatchObject({
      failure: {
        schemaVersion: 1,
        code: "STATE_UNCERTAIN",
        details: { phase: "daemon-error-details", originalDetailsAvailable: false },
      },
    })
    expect(JSON.stringify(body).length).toBeLessThan(1024 * 1024)
  },
)
