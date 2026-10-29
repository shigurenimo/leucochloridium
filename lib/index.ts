#!/usr/bin/env bun
import { randomUUID } from "node:crypto"
import { runCli } from "@/cli/run-cli"
import { writeCliError } from "@/cli/write-cli-error"
import { CliDeadline } from "@/cli/cli-deadline"

process.title = "leuco"
const requestId = randomUUID()
const execution: { deadline: CliDeadline | null } = { deadline: null }
try {
  execution.deadline = new CliDeadline(process.argv.slice(2), requestId)
  await runCli(process.argv.slice(2), { signal: execution.deadline.controller.signal, requestId })
} catch (error) {
  if (!execution.deadline?.expired) writeCliError(error, process.argv.slice(2), requestId)
} finally {
  execution.deadline?.finish()
}
