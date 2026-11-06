#!/usr/bin/env bun
import { randomUUID } from "node:crypto"
import { runCli } from "@/cli/run-cli"
import { writeCliError } from "@/cli/write-cli-error"
import { CliDeadline } from "@/cli/cli-deadline"
import { parseCliInvocation } from "@/cli/parse-cli-invocation"
import { CliError, ERROR_CODES } from "@/cli/cli-error"
import { errorDetails } from "@/error-details"

process.title = "leuco"
const args = process.argv.slice(2)
const requestId = randomUUID()
const execution: { deadline: CliDeadline | null; failed: boolean } = {
  deadline: null,
  failed: false,
}
const outputFailures: unknown[] = []
const recordOutputFailure = (error: unknown) => {
  if (outputFailures.length < 8) outputFailures.push(error)
  execution.deadline?.controller.abort(new Error("CLI output destination failed"))
}
process.stdout.on("error", recordOutputFailure)
process.stderr.on("error", recordOutputFailure)
const createOutputFailure = () =>
  new CliError(
    "STATE_UNCERTAIN",
    "CLI output delivery was not confirmed. Inspect current state before retrying the operation.",
    {
      phase: "output-flush",
      causes: errorDetails(new AggregateError(outputFailures, "CLI output delivery failed")),
    },
  )
try {
  const invocation = parseCliInvocation(args)
  execution.deadline = new CliDeadline(invocation, args, requestId)
  await runCli(args, { signal: execution.deadline.controller.signal, requestId, invocation })
} catch (error) {
  execution.failed = true
  execution.deadline?.stopObservation()
  if (!execution.deadline?.expired) {
    try {
      await writeCliError(outputFailures.length > 0 ? createOutputFailure() : error, args, {
        requestId,
      })
    } catch (reporting) {
      recordOutputFailure(reporting)
    }
  }
} finally {
  execution.deadline?.stopObservation()
  await execution.deadline?.errorOutput
  if (outputFailures.length > 0) {
    if (!execution.failed && !execution.deadline?.expired) {
      try {
        await writeCliError(createOutputFailure(), args, { requestId })
      } catch (error) {
        recordOutputFailure(error)
      }
    }
    process.exitCode = ERROR_CODES.STATE_UNCERTAIN.exitCode
  }
  execution.deadline?.finish()
  process.exit(process.exitCode ?? (execution.failed ? 1 : 0))
}
