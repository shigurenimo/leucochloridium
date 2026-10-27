#!/usr/bin/env bun
import { runCli } from "@/cli/run-cli"

process.title = "leuco"
try {
  await runCli(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`leuco: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
