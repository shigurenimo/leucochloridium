import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { MemoryDiagnosticOutput } from "@/memory-diagnostic-output"
import { writeCliError } from "@/cli/write-cli-error"
import type { CliErrorCode } from "@/cli/cli-error"
import { CliError } from "@/cli/cli-error"

const output = new MemoryDiagnosticOutput()
const request = { requestId: "d7775438-bb13-4885-8a6d-12fcd5adf4c9", output }
beforeEach(() => {
  output.attempts.length = 0
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})
it.each<CliErrorCode>(["STATE_CONFLICT", "NOT_RUNNING"])(
  "does not infer unchanged repair state from %s",
  async (code) => {
    await writeCliError(new CliError(code, "recovery failed"), ["repair", "--json"], request)
    const encoded = output.attempts[0]
    expect(typeof encoded).toBe("string")
    expect(String(encoded)).toContain('"mutationMayHaveOccurred":true')
  },
)
it("keeps pre-execution rejection for a duplicate start", async () => {
  await writeCliError(
    new CliError("STATE_CONFLICT", "already running"),
    ["start", "--json"],
    request,
  )
  expect(String(output.attempts[0])).toContain('"mutationMayHaveOccurred":false')
})
it("keeps repair input validation classified before execution", async () => {
  await writeCliError(new CliError("USAGE", "invalid arguments"), ["repair", "--json"], request)
  expect(String(output.attempts[0])).toContain('"mutationMayHaveOccurred":false')
})

it.each(["native", "cli"])("bounds the top-level %s error message after masking", async (kind) => {
  const message = `${"x".repeat(3983)} xoxb-synthetic-long-message-token ${"y".repeat(20_000)}`
  const failure = kind === "cli" ? new CliError("OPERATION_FAILED", message) : new Error(message)
  await writeCliError(failure, ["status", "--json"], request)
  const envelope = JSON.parse(String(output.attempts[0]))
  expect(envelope.error.message.length).toBeLessThanOrEqual(4000)
  expect(envelope.error.message).toMatch(/ \[truncated\]$/)
  expect(JSON.stringify(envelope)).not.toContain("xoxb-synthetic")
})
it("does not split a Unicode character at the CLI error message limit", async () => {
  await writeCliError(
    new Error(`${"x".repeat(3987)}😀${"y".repeat(10_000)}`),
    ["status", "--json"],
    request,
  )
  const envelope = JSON.parse(String(output.attempts[0]))
  expect(envelope.error.message).toBe(`${"x".repeat(3987)} [truncated]`)
})

it.each(["revoked", "throwing-prototype"])(
  "returns a structured error for a %s exception value",
  async (kind) => {
    const revocable = Proxy.revocable({}, {})
    revocable.revoke()
    const failure =
      kind === "revoked"
        ? revocable.proxy
        : new Proxy(
            {},
            {
              getPrototypeOf() {
                throw new Error("private-classification-failure")
              },
            },
          )
    await expect(writeCliError(failure, ["status", "--json"], request)).resolves.toBeUndefined()
    const encoded = String(output.attempts[0])
    const envelope = JSON.parse(encoded)
    expect(envelope).toMatchObject({
      ok: false,
      command: "status",
      error: {
        code: "OPERATION_FAILED",
        message: "[unprintable thrown value]",
        mutationMayHaveOccurred: false,
      },
    })
    expect(envelope.error.details.causes.length).toBeGreaterThan(0)
    expect(encoded).not.toContain("private-classification-failure")
    expect(process.exitCode).toBe(1)
  },
)

it.each([
  { operationCompleted: true },
  { executionStarted: true },
  { journalWritten: true },
  { mutationMayHaveOccurred: true },
  { executionStarted: false, mutationMayHaveOccurred: true },
])("does not erase reported effects when the error code is a conflict (%j)", async (details) => {
  await writeCliError(
    new CliError("STATE_CONFLICT", "conflict after work", details),
    ["restart", "--json"],
    request,
  )
  const envelope = JSON.parse(String(output.attempts[0]))
  expect(envelope.error.code).toBe("STATE_CONFLICT")
  expect(envelope.error.mutationMayHaveOccurred).toBe(true)
})
it("keeps read-only errors non-mutating even when their remote metadata reports effects", async () => {
  await writeCliError(
    new CliError("STATE_CONFLICT", "read failed", { mutationMayHaveOccurred: true }),
    ["status", "--json"],
    request,
  )
  expect(JSON.parse(String(output.attempts[0])).error.mutationMayHaveOccurred).toBe(false)
})

it.each(["cycle", "bigint", "throwing-json", "symbol"])(
  "keeps a structured failure when diagnostic metadata is %s",
  async (kind) => {
    const cyclic: { self: unknown } = { self: null }
    cyclic.self = cyclic
    const details =
      kind === "cycle"
        ? cyclic
        : kind === "bigint"
          ? { value: 1n }
          : kind === "symbol"
            ? Symbol("unsupported")
            : {
                toJSON() {
                  throw new Error("metadata failed xoxb-synthetic-diagnostic-token")
                },
              }
    const failure = new CliError("STATE_CONFLICT", "original conflict", details)
    failure.cause = Object.assign(new Error("original OS failure"), { code: "EACCES" })
    await expect(writeCliError(failure, ["restart", "--json"], request)).resolves.toBeUndefined()
    const encoded = String(output.attempts[0])
    const envelope = JSON.parse(encoded)
    expect(envelope).toMatchObject({
      requestId: request.requestId,
      command: "restart",
      error: {
        code: "STATE_CONFLICT",
        message: "original conflict",
        mutationMayHaveOccurred: true,
        details: { phase: "error-details", originalDetailsAvailable: false },
      },
    })
    expect(
      envelope.error.details.causes.some(
        (cause: { code: string | null }) => cause.code === "EACCES",
      ),
    ).toBe(true)
    expect(envelope.error.details.causes.length).toBeGreaterThan(1)
    expect(encoded).not.toContain("xoxb-synthetic")
    expect(process.exitCode).toBe(3)
  },
)
it("keeps a read-only failure non-mutating when its metadata cannot be serialized", async () => {
  await writeCliError(
    new CliError("STATE_CONFLICT", "read failed", { value: 1n }),
    ["status", "--json"],
    request,
  )
  expect(JSON.parse(String(output.attempts[0])).error.mutationMayHaveOccurred).toBe(false)
})
it("retains effect evidence hidden by a diagnostic toJSON method", async () => {
  await writeCliError(
    new CliError("STATE_CONFLICT", "conflict", {
      operationCompleted: true,
      toJSON() {
        return { message: "snapshot" }
      },
    }),
    ["restart", "--json"],
    request,
  )
  const envelope = JSON.parse(String(output.attempts[0]))
  expect(envelope.error.mutationMayHaveOccurred).toBe(true)
  expect(envelope.error.details).toEqual({ message: "snapshot" })
})

it.each(["constructor", "UNKNOWN", "throwing"])(
  "keeps malformed CLI error code %s structured and unsuccessful",
  async (code) => {
    const failure = new CliError("USAGE", "original failure")
    if (code === "throwing")
      Object.defineProperty(failure, "code", {
        get() {
          throw Error("unreadable code")
        },
      })
    else Object.defineProperty(failure, "code", { value: code })
    await expect(
      writeCliError(failure, ["ask", "test", "--json"], request),
    ).resolves.toBeUndefined()
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(output.attempts[0]))).toMatchObject({
      ok: false,
      error: {
        code: "OPERATION_FAILED",
        message: "original failure",
        mutationMayHaveOccurred: true,
      },
    })
  },
)

it.each([
  ["start", "--help", "--json"],
  ["repair", "--help", "--json"],
  ["ask", "--help", "--json"],
  ["slack", "call", "--help", "--json"],
])("does not report operation mutations after help output failure: %j", async (...args) => {
  await writeCliError(
    new CliError("STATE_UNCERTAIN", "Help output delivery failed", { phase: "output-flush" }),
    args,
    request,
  )
  expect(JSON.parse(String(output.attempts[0]))).toMatchObject({
    error: { code: "STATE_UNCERTAIN", mutationMayHaveOccurred: false },
  })
})

it("keeps literal --help prompt text classified as an executable request", async () => {
  await writeCliError(
    new CliError("STATE_UNCERTAIN", "Reply output delivery failed", { phase: "output-flush" }),
    ["ask", "--json", "--", "--help"],
    request,
  )
  expect(JSON.parse(String(output.attempts[0]))).toMatchObject({
    error: { mutationMayHaveOccurred: true },
  })
})

it.each([
  ["--version", "--json"],
  ["-v", "--json"],
])("identifies a failed version display without reporting mutation: %j", async (...args) => {
  await writeCliError(
    new CliError("STATE_UNCERTAIN", "Version output delivery failed", { phase: "output-flush" }),
    args,
    request,
  )
  expect(JSON.parse(String(output.attempts[0]))).toMatchObject({
    command: "version",
    error: { mutationMayHaveOccurred: false },
  })
})
