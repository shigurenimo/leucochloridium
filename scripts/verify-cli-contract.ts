import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"
import { Database } from "bun:sqlite"
import { writeFileSync } from "node:fs"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { getCliSpecification } from "@/cli/get-cli-specification"

const repository = resolve(import.meta.dir, "..")
const workspace = realpathSync(mkdtempSync("/tmp/leuco-contract-"))
const home = join(workspace, "state")
const cliPath = join(repository, "lib/index.ts")
const environment: NodeJS.ProcessEnv = { ...process.env, LEUCO_HOME: home }
async function cli(args: string[], exitCode = 0, env = environment) {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: workspace,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 20000)
  try {
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    assert.equal(await child.exited, exitCode, `${JSON.stringify(args)}\n${stdout}\n${stderr}`)
    return { stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}
function assertSuccess(command: string[], stdout: string) {
  assert.equal(stdout.trim().split("\n").length, 1)
  const envelope = JSON.parse(stdout)
  const specification = getCliSpecification(command).commands.find(
    (entry) => entry.name === command.join(" "),
  )!
  z.fromJSONSchema(specification.outputSchema).parse(envelope)
  assert.equal(envelope.ok, true)
  return envelope.data
}
function assertFailure(stderr: string, code: string) {
  assert.equal(stderr.trim().split("\n").length, 1)
  const error = JSON.parse(stderr)
  z.fromJSONSchema(getCliSpecification().errorSchema).parse(error)
  assert.equal(error.error.code, code)
  return error.error
}
try {
  const schema = JSON.parse((await cli(["--help", "--json"])).stdout)
  assert.equal(schema.schemaVersion, 1)
  for (const command of schema.commands) {
    const words = command.name.split(" ")
    const help = await cli([...words, "--help"])
    assert.ok(help.stdout.includes(command.description))
    const machine = JSON.parse((await cli([...words, "--help", "--json"])).stdout)
    assert.equal(machine.commands[0].name, command.name)
    assert.equal(machine.schemaVersion, 1)
  }
  for (const args of [
    ["status"],
    ["config", "show"],
    ["schedules", "list"],
    ["session", "list"],
    ["logs"],
    ["events"],
  ]) {
    const result = await cli([...args, "--json"])
    assertSuccess(args, result.stdout)
    assert.equal(result.stderr, "")
  }
  assert.equal(existsSync(home), false, "Read-only/help commands created Leuco state")
  for (const args of [
    ["slack", "call", "chat.postMessage"],
    ["slack", "call", "chat.postMessage", "--body", "[]"],
    ["schedules", "add", "--name", "missing"],
    ["config", "set", "model", "bad-json"],
    ["config", "set", "unknown-key", "null"],
    ["config", "set", "model", "99"],
    ["run", "--thread", "missing-prompt"],
    ["logs", "--limit", "10001"],
    ["status", "--bogus"],
    ["projects"],
  ]) {
    const result = await cli([...args, "--json"], 2)
    assert.equal(result.stdout, "")
    assert.equal(assertFailure(result.stderr, "USAGE").mutationMayHaveOccurred, false)
  }
  assert.equal(existsSync(home), false, "Invalid requests wrote state")
  const ask = await cli(["ask", "request", "--json"], 3)
  assert.equal(ask.stdout, "")
  assertFailure(ask.stderr, "NOT_RUNNING")
  const login = await cli(["slack", "login", "--json"], 2)
  assert.equal(login.stdout, "")
  assertFailure(login.stderr, "USAGE")
  const unsafeText = await cli(["ask", "--", "--json"], 3)
  assert.equal(
    Bun.YAML.parse(unsafeText.stderr) && unsafeText.stderr.includes("code: NOT_RUNNING"),
    true,
  )
  mkdirSync(home, { recursive: true })
  const log = new LeucoEventLog({ eventLogPath: join(home, "events.db") })
  log.append({ ts: 1, type: "runtime.started", runtime: "leuco" })
  log.append({ ts: 2, type: "runtime.stopped", runtime: "leuco" })
  log.close()
  const checkpoint = new Database(join(home, "events.db"))
  checkpoint.run("PRAGMA wal_checkpoint(TRUNCATE)")
  checkpoint.close()
  const fingerprint = () =>
    createHash("sha256")
      .update(readFileSync(join(home, "events.db")))
      .digest("hex")
  const before = fingerprint()
  const events = assertSuccess(["events"], (await cli(["events", "--json"])).stdout)
  assert.ok(events[0].seq > events[1].seq)
  assert.equal(fingerprint(), before, "Event inspection modified the database")
  assertSuccess(["config", "set"], (await cli(["config", "set", "soul", "null", "--json"])).stdout)
  const diagnostic = await cli(["doctor", "--json"], 1, {
    ...environment,
    PATH: "",
    CODEX_HOME: join(workspace, "codex"),
  })
  assert.equal(diagnostic.stdout, "")
  assert.equal(assertFailure(diagnostic.stderr, "CHECK_FAILED").details.codex, null)
  const fake = join(workspace, "codex-bin")
  writeFileSync(
    fake,
    `#!/bin/sh\nexec '${process.execPath}' '${join(repository, "scripts/fixtures/fake-codex.ts")}' "$@"\n`,
    { mode: 0o700 },
  )
  const diagnosticBin = join(workspace, "diagnostic-bin")
  mkdirSync(diagnosticBin)
  symlinkSync(fake, join(diagnosticBin, "codex"))
  const diagnosticEnvironment = { ...environment, PATH: diagnosticBin }
  const stoppedDiagnostic = assertFailure(
    (await cli(["doctor", "--json"], 1, diagnosticEnvironment)).stderr,
    "CHECK_FAILED",
  ).details
  assert.equal(stoppedDiagnostic.healthy, false)
  assert.ok(stoppedDiagnostic.errors.some((message: string) => message.includes("leuco start")))
  writeFileSync(join(home, "daemon.json"), "invalid-lease-sentinel")
  writeFileSync(join(home, "state.json"), "invalid-state-sentinel")
  const unknownOwnership = assertFailure(
    (await cli(["doctor", "--json"], 1, diagnosticEnvironment)).stderr,
    "CHECK_FAILED",
  ).details
  assert.equal(unknownOwnership.daemon.running, null)
  assert.equal(unknownOwnership.repairable.invalidState, false)
  assert.equal(
    unknownOwnership.errors.some((message: string) => message.includes("leuco start")),
    false,
  )
  assert.equal(readFileSync(join(home, "daemon.json"), "utf8"), "invalid-lease-sentinel")
  rmSync(join(home, "daemon.json"))
  rmSync(join(home, "state.json"))
  await cli([
    "config",
    "set",
    "slack",
    JSON.stringify({ credential: "11111111-1111-4111-8111-111111111111" }),
    "--json",
  ])
  const missingCli = assertFailure(
    (await cli(["doctor", "--json"], 1, diagnosticEnvironment)).stderr,
    "CHECK_FAILED",
  ).details
  assert.equal(missingCli.cli, null)
  assert.ok(missingCli.errors.some((message: string) => message.includes("bun link")))
  symlinkSync(cliPath, join(diagnosticBin, "leuco"))
  const linkedCli = assertFailure(
    (await cli(["doctor", "--json"], 1, diagnosticEnvironment)).stderr,
    "CHECK_FAILED",
  ).details
  assert.equal(linkedCli.cli, join(diagnosticBin, "leuco"))
  assert.equal(
    linkedCli.errors.some((message: string) => message.includes("bun link")),
    false,
  )
  await cli(["config", "set", "slack", "null", "--json"])
  const agentEnvironment = {
    ...environment,
    LEUCO_VERIFY_TRACE: join(workspace, "trace.jsonl"),
    CODEX_HOME: join(workspace, "codex"),
  }
  const diagnosticSecret = "xoxb-synthetic-startup-diagnostic-token"
  writeFileSync(
    join(home, "daemon.log"),
    `${"old diagnostic context\n".repeat(1000)}${diagnosticSecret}\n`,
  )
  const missingCodex = join(workspace, "missing-codex-for-startup-diagnosis")
  const failedStart = assertFailure(
    (await cli(["start", "--codex-bin", missingCodex, "--json"], 1, agentEnvironment)).stderr,
    "OPERATION_FAILED",
  ).details
  assert.equal(failedStart.exitCode, 1)
  assert.equal(failedStart.signal, null)
  assert.equal(failedStart.logPath, join(home, "daemon.log"))
  assert.ok(failedStart.logTail.includes(missingCodex))
  assert.ok(failedStart.logTail.length <= 16_000)
  assert.equal(JSON.stringify(failedStart).includes(diagnosticSecret), false)
  assert.ok(failedStart.logTail.includes("[redacted]"))
  assert.equal(failedStart.logReadFailure, null)
  const oneShot = assertSuccess(
    ["run"],
    (
      await cli(
        ["run", "--codex-bin", fake, "--prompt=--data-not-options", "--json"],
        0,
        agentEnvironment,
      )
    ).stdout,
  )
  assert.equal(oneShot.reply, "verified reply")
  assert.equal(oneShot.cancelled, false)
  assertSuccess(
    ["start"],
    (await cli(["start", "--codex-bin", fake, "--json"], 0, agentEnvironment)).stdout,
  )
  const conflict = await cli(["start", "--codex-bin", fake, "--json"], 3, agentEnvironment)
  assertFailure(conflict.stderr, "STATE_CONFLICT")
  assertSuccess(
    ["ask"],
    (await cli(["ask", "--json", "--", "--this-is-data"], 0, agentEnvironment)).stdout,
  )
  assertSuccess(["status"], (await cli(["status", "--json"], 0, agentEnvironment)).stdout)
  const stopped = JSON.parse((await cli(["stop", "--json"], 0, agentEnvironment)).stdout)
  const shutdownHistory = assertSuccess(
    ["events"],
    (await cli(["events", "--request", stopped.requestId, "--type", "log", "--json"])).stdout,
  )
  assert.ok(
    shutdownHistory.some((entry: { event: { line: string } }) =>
      entry.event.line.includes("control request"),
    ),
  )
  const signalDaemon = assertSuccess(
    ["start"],
    (await cli(["start", "--codex-bin", fake, "--json"], 0, agentEnvironment)).stdout,
  )
  process.kill(signalDaemon.pid, "SIGTERM")
  const stoppedBySignal = { confirmed: false }
  const signalDeadline = Date.now() + 5000
  while (Date.now() < signalDeadline) {
    if (JSON.parse((await cli(["status", "--json"])).stdout).data.running === false) {
      stoppedBySignal.confirmed = true
      break
    }
    await Bun.sleep(20)
  }
  assert.equal(stoppedBySignal.confirmed, true)
  const signalHistory = assertSuccess(
    ["events"],
    (await cli(["events", "--type", "log", "--json"])).stdout,
  )
  assert.ok(
    signalHistory.some((entry: { event: { line: string } }) =>
      entry.event.line.includes("shutdown requested: SIGTERM"),
    ),
  )
  console.log(
    "CLI contract passed: every command discoverable, valid result/error schemas, no help/read side effects",
  )
} finally {
  await cli(["stop"]).catch(() => {})
  rmSync(workspace, { recursive: true, force: true })
}
