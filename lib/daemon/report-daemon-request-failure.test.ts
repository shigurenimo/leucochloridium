import { expect, it } from "vitest"
import { type CliErrorCode, CliError } from "@/cli/cli-error"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { reportDaemonRequestFailure } from "@/daemon/report-daemon-request-failure"

it.each<[CliErrorCode, unknown, string]>([
  ["USAGE", { phase: "validation", executionStarted: false }, "warn"],
  ["USAGE", { phase: "control-body", executionStarted: false }, "warn"],
  ["USAGE", { phase: "validation", executionStarted: true }, "error"],
  [
    "USAGE",
    { phase: "validation", executionStarted: false, mutationMayHaveOccurred: true },
    "error",
  ],
  ["USAGE", { phase: "validation", executionStarted: false, operationCompleted: true }, "error"],
  ["USAGE", { phase: "validation", executionStarted: false, journalWritten: true }, "error"],
  ["USAGE", {}, "error"],
  ["STATE_UNCERTAIN", { phase: "validation", executionStarted: false }, "error"],
])("classifies %s with %j as %s", (code, details, level) => {
  const log = new LeucoEventLog()
  reportDaemonRequestFailure(log, new CliError(code, "invalid request", details), "request-one")
  expect(log.query()[0]?.event).toMatchObject({
    type: "log",
    level,
    requestId: "request-one",
    causes: [expect.objectContaining({ name: "CliError", code })],
  })
})

it("masks a known secret before diagnostic field truncation", () => {
  const log = new LeucoEventLog()
  const secret = "private-control-value-crossing-boundary"
  log.setRedactionSecrets([secret])
  const error = new CliError("USAGE", `${"a".repeat(3980)}${secret}`, {
    phase: "validation",
    executionStarted: false,
  })
  error.stack = `Error: ${"s".repeat(7980)}${secret}`
  reportDaemonRequestFailure(log, error, "masked-request")
  const output = JSON.stringify(log.query())
  expect(output).not.toContain("private-")
  expect(output).toContain("[redacted]")
})
