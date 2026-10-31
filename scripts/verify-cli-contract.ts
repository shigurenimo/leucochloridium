import type { LeucoEvent } from "@/events/leuco-event-types"
import { SqliteEventLog } from "@/event-log/sqlite-event-log"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  statSync,
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"
import { Database } from "bun:sqlite"
import { writeFileSync } from "node:fs"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { getCliSpecification } from "@/cli/get-cli-specification"
import { requestDaemon } from "@/daemon/request-daemon"
import { CliError } from "@/cli/cli-error"
import { daemonErrorResponse } from "@/daemon/daemon-error-response"
import { daemonRejectionResponse } from "@/daemon/daemon-rejection-response"
import { errorDetails } from "@/error-details"

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
  const legacyPath = join(workspace, "legacy-api-history", "events.db")
  const legacy = new SqliteEventLog<LeucoEvent, ["runtime"]>({
    path: legacyPath,
    indexes: ["runtime"],
    extractIndexes: () => ({ runtime: null }),
  })
  const originalLine =
    "legacy socket wss://wss-primary.slack.com/link/?ticket=synthetic-legacy-ticket&app_id=synthetic-app failed: ECONNRESET"
  try {
    legacy.insert({
      ts: Date.now(),
      event: { ts: Date.now(), type: "log", level: "error", line: originalLine },
    })
  } finally {
    legacy.close()
  }
  const reader = new LeucoEventLog({ eventLogPath: legacyPath })
  try {
    const entry = reader.query()[0]
    assert.equal(entry?.seq, 1)
    assert.ok(entry?.event.type === "log")
    assert.equal(
      entry.event.line,
      "legacy socket wss://wss-primary.slack.com/link/?[redacted] failed: ECONNRESET",
    )
  } finally {
    reader.close()
  }
  const originalDatabase = new Database(legacyPath, { readonly: true })
  try {
    const row = z
      .object({ event: z.string() })
      .parse(originalDatabase.query("SELECT event FROM logs WHERE seq = 1").get())
    assert.equal(
      JSON.parse(row.event).line,
      originalLine,
      "Reading rewrote original diagnostic history",
    )
  } finally {
    originalDatabase.close()
  }
  const schema = JSON.parse((await cli(["--help", "--json"])).stdout)
  assert.equal(schema.schemaVersion, 1)
  for (const group of ["config", "schedules", "session"]) {
    const help = await cli([group, "--help"])
    const machine = JSON.parse((await cli([group, "--help", "--json"])).stdout)
    const commands = schema.commands.filter((command: { name: string }) =>
      command.name.startsWith(`${group} `),
    )
    assert.deepEqual(machine.commands, commands)
    for (const command of commands) assert.ok(help.stdout.includes(command.name))
  }
  assert.deepEqual(schema.outputDelivery, {
    timeoutMs: { stdout: 4000, stderr: 1000 },
    successRequiresExitCode: 0,
    unconfirmed: {
      errorCode: "STATE_UNCERTAIN",
      exitCode: 5,
      phase: "output-flush",
      retryAutomatically: false,
    },
  })
  const yamlHelp = z
    .object({ outputDelivery: z.unknown() })
    .parse(Bun.YAML.parse((await cli(["--help", "--yaml"])).stdout))
  assert.deepEqual(yamlHelp.outputDelivery, schema.outputDelivery)
  for (const command of schema.commands) {
    const words = command.name.split(" ")
    const help = await cli([...words, "--help"])
    assert.ok(help.stdout.includes(command.description))
    const machine = JSON.parse((await cli([...words, "--help", "--json"])).stdout)
    assert.equal(machine.commands[0].name, command.name)
    assert.equal(machine.schemaVersion, 1)
    assert.deepEqual(machine.outputDelivery, schema.outputDelivery)
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
  for (const args of [
    ["--version", "--json"],
    ["-v", "--json"],
  ]) {
    const version = await cli(args)
    z.fromJSONSchema(getCliSpecification().versionOutputSchema).parse(JSON.parse(version.stdout))
    assert.equal(version.stderr, "")
  }
  assert.equal((await cli(["--version"])).stdout.trim(), schema.cliVersion)
  const yamlVersion = z
    .object({ data: z.object({ version: z.string() }) })
    .parse(Bun.YAML.parse((await cli(["-v", "--yaml"])).stdout))
  assert.equal(yamlVersion.data.version, schema.cliVersion)
  for (const args of [
    ["--version", "--json", "--yaml"],
    ["--version", "--version", "--json"],
    ["--version", "-v", "--json"],
    ["--version", "--json", "--json"],
  ]) {
    const invalidVersion = await cli(args, 2)
    assert.equal(invalidVersion.stdout, "")
    assert.equal(assertFailure(invalidVersion.stderr, "USAGE").mutationMayHaveOccurred, false)
  }
  assert.equal(existsSync(home), false, "Read-only/help commands created Leuco state")
  const initialEntries = readdirSync(workspace).sort()
  const initialMode = statSync(workspace).mode & 0o777
  const emptyHomeEnvironment = { ...environment, LEUCO_HOME: "" }
  const emptyHome = await cli(
    ["config", "set", "model", '"must-not-save"', "--json"],
    2,
    emptyHomeEnvironment,
  )
  assert.equal(emptyHome.stdout, "")
  const emptyHomeError = assertFailure(emptyHome.stderr, "USAGE")
  assert.equal(emptyHomeError.mutationMayHaveOccurred, false)
  assert.match(emptyHomeError.message, /LEUCO_HOME/)
  await cli(["--help"], 0, emptyHomeEnvironment)
  await cli(["--version", "--json"], 0, emptyHomeEnvironment)
  assert.deepEqual(readdirSync(workspace).sort(), initialEntries)
  assert.equal(statSync(workspace).mode & 0o777, initialMode)
  for (const args of [
    ["slack", "call", "chat.postMessage"],
    ["config", "set", "model", '" "'],
    ["config"],
    ["schedules"],
    ["session"],
    ["slack", "call", "chat.postMessage", "--body", "[]"],
    ["schedules", "add", "--name", "missing"],
    ["schedules", "remove", "missing"],
    ["ask", "   "],
    ["schedules", "add", "--name", "blank", "--run-at", "* * * * *", "--prompt", "　"],
    ["start", "--model", "sample-model"],
    ["run", "--prompt", "probe", "--model", "sample-model"],
    ["restart", "--model", "sample-model"],
    ["start", "--codex-bin", "/custom/codex"],
    ["run", "--prompt", "probe", "--codex-bin", "/custom/codex"],
    ["restart", "--codex-bin", "/custom/codex"],
    ["schedules", "add", "--name", "invalid-time", "--run-at", "not-a-time", "--prompt", "probe"],
    [
      "schedules",
      "add",
      "--name",
      "no-zone",
      "--run-at",
      "2999-01-01T09:00:00",
      "--prompt",
      "probe",
    ],
    [
      "schedules",
      "add",
      "--name",
      "invalid-date",
      "--run-at",
      "2999-02-29T09:00:00Z",
      "--prompt",
      "probe",
    ],
    [
      "config",
      "set",
      "schedules",
      JSON.stringify([
        { id: "no-zone", name: "no-zone", runAt: "2999-01-01T09:00:00", prompt: "probe" },
      ]),
    ],
    ["config", "set", "model", "bad-json"],
    ["config", "set", "unknown-key", "null"],
    ["config", "set", "model", "99"],
    ["config", "set", "turnTimeoutMs", "2147483648"],
    ["config", "set", "idleTimeoutMs", "2147483648"],
    [
      "config",
      "set",
      "schedules",
      JSON.stringify([
        { id: "one", name: "one", runAt: "0 9 * * *", prompt: "probe", timezone: "UTC" },
      ]),
    ],
    [
      "config",
      "set",
      "schedules",
      JSON.stringify([{ id: "invalid", name: "invalid", runAt: "not-a-time", prompt: "probe" }]),
    ],
    [
      "config",
      "set",
      "schedules",
      JSON.stringify([
        { id: "past", name: "past", runAt: "2000-01-01T00:00:00Z", prompt: "probe" },
      ]),
    ],
    ["run", "--thread", "missing-prompt"],
    ["run", "--prompt", "probe"],
    ["logs", "--limit", "10001"],
    [`--${"x".repeat(20_000)}`],
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
  const control = { mode: "memory-fallback" }
  const controlSocket = join(home, "control.sock")
  const server = Bun.serve({
    unix: controlSocket,
    fetch(request) {
      if (control.mode === "wrong-status-pid")
        return Response.json({
          running: true,
          ready: true,
          pid: process.pid + 1,
          cwd: workspace,
          runtime: { codexRunning: false },
        })
      if (control.mode === "stopped-status") return Response.json({ running: false })
      if (control.mode === "changed-status-owner") {
        writeFileSync(
          join(home, "daemon.json"),
          JSON.stringify({ pid: process.pid, token: randomUUID() }),
        )
        return Response.json({ running: true, ready: true, pid: process.pid, cwd: workspace })
      }
      if (control.mode === "malformed-status") return Response.json({ running: true, ready: true })
      if (control.mode === "malformed-restart")
        return Response.json({ id: "not-a-uuid", status: "ready" })
      if (control.mode === "confirmed-refusal")
        return daemonRejectionResponse({
          status: 503,
          phase: "readiness",
          message: "not ready",
          requestId: request.headers.get("x-leuco-request-id") ?? randomUUID(),
        })
      if (["classified-effect", "classified-unknown", "classified-claim"].includes(control.mode)) {
        const marker = join(workspace, "accepted-conflict.json")
        const count = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")).count : 0
        writeFileSync(marker, JSON.stringify({ count: count + 1 }))
        return daemonErrorResponse({
          error: new CliError(
            "STATE_CONFLICT",
            "conflict after acceptance",
            control.mode === "classified-effect"
              ? { operationCompleted: true }
              : control.mode === "classified-claim"
                ? { mutationMayHaveOccurred: false }
                : null,
          ),
          status: 422,
          requestId: request.headers.get("x-leuco-request-id") ?? randomUUID(),
        })
      }
      if (control.mode === "plain-error")
        return new Response("service unavailable", { status: 503 })
      if (control.mode === "oversized-response")
        return new Response("x".repeat(16 * 1024 * 1024 + 1))
      if (control.mode === "stalled-response")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode(`{${" ".repeat(64 * 1024)}`))
            },
          }),
        )
      if (new URL(request.url).pathname === "/status") {
        if (control.mode === "hang") return new Promise<Response>(() => {})
        if (control.mode === "unavailable")
          return Response.json({ error: "control unavailable" }, { status: 503 })
        return Response.json({
          running: true,
          ready: true,
          pid: process.pid,
          cwd: workspace,
          runtime: {
            logs: {
              mode: control.mode === "sqlite" ? "sqlite" : "memory-fallback",
              failedWrites: 0,
              lastWriteFailed: false,
              lastPersistError: null,
            },
          },
        })
      }
      if (control.mode === "invalid-events") return Response.json({ invalid: "event response" })
      if (control.mode === "unordered-events" || control.mode === "excess-events") {
        const entries = [1, 2].map((seq) => ({
          seq,
          ts: seq,
          event: { ts: seq, type: "runtime.started", runtime: "leuco" },
        }))
        return Response.json(control.mode === "excess-events" ? entries.reverse() : entries)
      }
      if (control.mode === "ignored-event-filter")
        return Response.json([
          { seq: 1, ts: 1, event: { ts: 1, type: "runtime.stopped", runtime: "leuco" } },
        ])
      return Response.json({ error: "volatile event history unavailable" }, { status: 503 })
    },
  })
  writeFileSync(
    join(home, "daemon.json"),
    JSON.stringify({ pid: process.pid, token: randomUUID() }),
  )
  try {
    control.mode = "malformed-status"
    const malformedStatus = await cli(["status", "--json"], 5)
    assert.equal(malformedStatus.stdout, "")
    assert.equal(assertFailure(malformedStatus.stderr, "STATE_UNCERTAIN").details.phase, "status")
    control.mode = "wrong-status-pid"
    const wrongPid = assertFailure((await cli(["status", "--json"], 5)).stderr, "STATE_UNCERTAIN")
    assert.equal(wrongPid.details.expectedPid, process.pid)
    assert.equal(wrongPid.details.reportedPid, process.pid + 1)
    const repairMismatch = assertFailure(
      (await cli(["repair", "--json"], 5)).stderr,
      "STATE_UNCERTAIN",
    )
    assert.equal(repairMismatch.details.phase, "identity")
    assert.equal(
      existsSync(join(home, "maintenance.json")),
      false,
      "Repair scheduled a worker for unverified status",
    )
    const doctorMismatch = assertFailure(
      (await cli(["doctor", "--json"], 1)).stderr,
      "CHECK_FAILED",
    )
    assert.ok(
      JSON.stringify(doctorMismatch.details).includes("does not match authenticated lease PID"),
    )
    control.mode = "stopped-status"
    assert.equal(
      assertFailure((await cli(["status", "--json"], 5)).stderr, "STATE_UNCERTAIN").details.phase,
      "status",
    )
    control.mode = "changed-status-owner"
    const changedOwner = assertFailure(
      (await cli(["status", "--json"], 3)).stderr,
      "STATE_CONFLICT",
    )
    assert.equal(changedOwner.details.phase, "identity")
    chmodSync(join(home, "events.db"), 0o644)
    const changedRepairOwner = assertFailure(
      (await cli(["repair", "--json"], 3)).stderr,
      "STATE_CONFLICT",
    )
    assert.equal(statSync(join(home, "events.db")).mode & 0o777, 0o600)
    assert.equal(changedRepairOwner.mutationMayHaveOccurred, true)

    control.mode = "malformed-restart"
    const malformedRestart = await cli(["restart", "--json"], 5)
    assert.equal(malformedRestart.stdout, "")
    const restartContractFailure = assertFailure(malformedRestart.stderr, "STATE_UNCERTAIN")
    assert.equal(restartContractFailure.mutationMayHaveOccurred, true)
    assert.equal(restartContractFailure.details.phase, "output")
    assert.equal(existsSync(join(home, "maintenance.json")), false)
    control.mode = "plain-error"
    const plainError = assertFailure((await cli(["status", "--json"], 5)).stderr, "STATE_UNCERTAIN")
    assert.equal(plainError.details.status, 503)
    assert.equal(plainError.details.phase, "error-body")
    assert.ok(
      plainError.details.causes.some((cause: { name: string }) => cause.name === "SyntaxError"),
    )
    control.mode = "confirmed-refusal"
    const refused = assertFailure((await cli(["restart", "--json"], 3)).stderr, "STATE_CONFLICT")
    assert.equal(refused.mutationMayHaveOccurred, false)
    assert.equal(refused.details.executionStarted, false)
    assert.equal(refused.details.phase, "readiness")
    for (const mode of ["classified-effect", "classified-unknown", "classified-claim"]) {
      control.mode = mode
      const conflict = assertFailure((await cli(["restart", "--json"], 3)).stderr, "STATE_CONFLICT")
      assert.equal(
        conflict.mutationMayHaveOccurred,
        true,
        `Classified daemon failure falsely proved no mutation: ${mode}`,
      )
      assert.equal(
        JSON.parse(readFileSync(join(workspace, "accepted-conflict.json"), "utf8")).count,
        ["classified-effect", "classified-unknown", "classified-claim"].indexOf(mode) + 1,
        "Failed work was replayed",
      )
    }
    control.mode = "oversized-response"
    const oversized = assertFailure((await cli(["status", "--json"], 5)).stderr, "STATE_UNCERTAIN")
    assert.equal(oversized.details.status, 200)
    assert.match(oversized.message, /16777216/)
    control.mode = "stalled-response"
    const stalled = await requestDaemon({ home, path: "/status", timeoutMs: 200 }).catch(
      (error: unknown) => error,
    )
    assert.ok(errorDetails(stalled).some((cause) => cause.name === "TimeoutError"))
    z.object({
      details: z.object({
        phase: z.literal("body"),
        request: z.object({
          method: z.literal("GET"),
          path: z.literal("/status"),
          leasePid: z.literal(process.pid),
          timeoutMs: z.literal(200),
          elapsedMs: z.number().nonnegative(),
          aborted: z.literal(true),
          callerAborted: z.literal(false),
        }),
      }),
    }).parse(stalled)
    for (const mode of [
      "memory-fallback",
      "unavailable",
      "hang",
      "invalid-events",
      "unordered-events",
      "excess-events",
      "ignored-event-filter",
    ]) {
      control.mode = mode
      const uncertain = await cli(
        [
          "events",
          "--type",
          "runtime.started",
          "--limit",
          mode === "excess-events" ? "1" : "100",
          "--json",
        ],
        5,
      )
      assert.equal(uncertain.stdout, "")
      const failure = assertFailure(uncertain.stderr, "STATE_UNCERTAIN")
      assert.equal(failure.mutationMayHaveOccurred, false)
      assert.equal(failure.details.savedEvents.length, 1)
      assert.equal(failure.details.savedEvents[0].event.type, "runtime.started")
      assert.ok(failure.details.causes.length > 0)
      if (mode === "hang") {
        assert.ok(
          failure.details.causes.some(
            (cause: { message: string }) =>
              cause.message.includes("GET /status") && cause.message.includes("budget=200ms"),
          ),
          "History wrapper lost request route and budget",
        )
        assert.ok(
          failure.details.causes.some((cause: { name: string }) => cause.name !== "CliError"),
          "Underlying transport failure was hidden by the CLI wrapper",
        )
      }
    }
    control.mode = "sqlite"
    const savedDatabase = join(home, "events.saved.db")
    renameSync(join(home, "events.db"), savedDatabase)
    try {
      const missingDatabase = assertFailure(
        (await cli(["events", "--json"], 5)).stderr,
        "STATE_UNCERTAIN",
      )
      assert.match(missingDatabase.message, /missing/)
    } finally {
      renameSync(savedDatabase, join(home, "events.db"))
    }
  } finally {
    await server.stop(true)
    rmSync(join(home, "daemon.json"), { force: true })
    rmSync(controlSocket, { force: true })
  }
  const noisyLog = new LeucoEventLog({ eventLogPath: join(home, "events.db") })
  noisyLog.log("warn", "summary warning", "summary-request")
  for (const _ of Array.from({ length: 25 })) {
    noisyLog.log("info", "summary noise", "summary-request")
    noisyLog.append({
      ts: 3,
      type: "codex.notification",
      runtime: "leuco",
      method: "hook/completed",
      params: {},
      requestId: "summary-request",
    })
  }
  noisyLog.close()
  const summary = assertSuccess(
    ["events"],
    (await cli(["events", "--summary", "--request", "summary-request", "--limit", "1", "--json"]))
      .stdout,
  )
  assert.equal(summary.length, 1)
  assert.equal(summary[0].event.line, "summary warning")
  const raw = assertSuccess(["events"], (await cli(["events", "--limit", "1", "--json"])).stdout)
  assert.equal(raw[0].event.type, "codex.notification")
  const failureLog = new LeucoEventLog({ eventLogPath: join(home, "events.db") })
  failureLog.log("error", "failure hidden behind notification noise")
  failureLog.append({
    ts: 4,
    type: "turn.error",
    runtime: "leuco",
    threadKey: "cancelled",
    error: "cancellation-not-failure",
    cancelled: true,
  })
  failureLog.append({
    ts: 4,
    type: "supervisor.reconcile.failed",
    reason: "supervisor-failure-probe",
  })
  failureLog.append({
    ts: 4,
    type: "turn.rejected",
    runtime: "leuco",
    threadKey: "rejection-probe",
    reason: "queue_count_limit",
    queueDepth: 64,
    queueBytes: 0,
    inputBytes: 1,
    maxQueueDepth: 64,
    maxQueueBytes: 262144,
  })
  for (const status of ["failed", "succeeded"] satisfies ReadonlyArray<"failed" | "succeeded">)
    failureLog.append({
      ts: 4,
      type: "codex.recovery",
      runtime: "leuco",
      reason: "recovery-probe",
      status,
      durationMs: 1,
      error: status === "failed" ? "recovery-failure-probe" : null,
    })
  for (const status of ["failed", "uncertain", "ready"] satisfies ReadonlyArray<
    "failed" | "uncertain" | "ready"
  >)
    failureLog.append({
      ts: 4,
      type: "maintenance",
      operationId: "maintenance-probe",
      status,
      workerPid: null,
      oldPid: null,
      newPid: null,
      error: status === "ready" ? null : "maintenance-failure-probe",
    })
  failureLog.append({
    ts: 4,
    type: "slack.error",
    runtime: "leuco",
    connector: "slack",
    level: "error",
    action: "connection-failure-probe",
    message: "slack-failure-probe",
    error: "connection failed",
  })
  for (const _ of Array.from({ length: 25 }))
    failureLog.append({
      ts: 4,
      type: "slack.error",
      runtime: "leuco",
      connector: "slack",
      level: "warn",
      action: "wake.detected",
      message: "wake-warning-probe",
      error: null,
    })
  for (const _ of Array.from({ length: 150 }))
    failureLog.append({
      ts: 4,
      type: "codex.notification",
      runtime: "leuco",
      method: "hook/completed",
      params: {},
    })
  failureLog.close()
  assertSuccess(["config", "set"], (await cli(["config", "set", "soul", "null", "--json"])).stdout)
  const scheduleArguments = [
    "schedules",
    "add",
    "--name",
    "duplicate-probe",
    "--run-at",
    "0 9 * * *",
    "--prompt",
    "probe",
    "--json",
  ]
  assertSuccess(["schedules", "add"], (await cli(scheduleArguments)).stdout)
  const settingsSnapshot = readFileSync(join(home, "settings.json"), "utf8")
  const duplicate = assertFailure((await cli(scheduleArguments, 2)).stderr, "USAGE")
  assert.equal(duplicate.mutationMayHaveOccurred, false)
  assert.match(duplicate.message, /already exists/)
  assert.equal(readFileSync(join(home, "settings.json"), "utf8"), settingsSnapshot)
  const unsupportedSchedule = assertFailure(
    (
      await cli(
        [
          "config",
          "set",
          "schedules",
          JSON.stringify([
            { id: "one", name: "one", runAt: "0 9 * * *", prompt: "probe", timezone: "UTC" },
          ]),
          "--json",
        ],
        2,
      )
    ).stderr,
    "USAGE",
  )
  assert.equal(unsupportedSchedule.mutationMayHaveOccurred, false)
  assert.match(JSON.stringify(unsupportedSchedule.details), /unrecognized_keys/)
  assert.match(JSON.stringify(unsupportedSchedule.details), /timezone/)
  assert.equal(readFileSync(join(home, "settings.json"), "utf8"), settingsSnapshot)
  await cli(["schedules", "remove", "duplicate-probe", "--json"])
  const diagnostic = await cli(["doctor", "--json"], 1, {
    ...environment,
    PATH: "",
    CODEX_HOME: join(workspace, "codex"),
  })
  assert.equal(diagnostic.stdout, "")
  assert.equal(assertFailure(diagnostic.stderr, "CHECK_FAILED").details.codex, null)
  assert.ok(
    assertFailure(diagnostic.stderr, "CHECK_FAILED").details.recentFailures.some(
      (entry: { event: { line?: string } }) =>
        entry.event.line === "failure hidden behind notification noise",
    ),
  )
  assert.equal(
    JSON.stringify(
      assertFailure(diagnostic.stderr, "CHECK_FAILED").details.recentFailures,
    ).includes("cancellation-not-failure"),
    false,
  )
  const diagnosticFailures = assertFailure(diagnostic.stderr, "CHECK_FAILED").details.recentFailures
  assert.ok(
    !JSON.stringify(diagnosticFailures).includes("wake-warning-probe"),
    "Wake warnings displaced actual failures",
  )
  for (const type of [
    "supervisor.reconcile.failed",
    "turn.rejected",
    "codex.recovery",
    "maintenance",
    "slack.error",
  ])
    assert.ok(
      diagnosticFailures.some((entry: { event: { type: string } }) => entry.event.type === type),
      `Missing failure type: ${type}`,
    )
  assert.ok(
    diagnosticFailures.some(
      (entry: { event: { type: string; status?: string } }) =>
        entry.event.type === "maintenance" && entry.event.status === "uncertain",
    ),
  )
  assert.ok(
    !diagnosticFailures.some((entry: { event: { status?: string } }) =>
      ["ready", "succeeded"].includes(entry.event.status ?? ""),
    ),
  )
  const warningHistory = assertSuccess(
    ["events"],
    (await cli(["events", "--type", "slack.error", "--summary", "--limit", "1", "--json"])).stdout,
  )
  assert.equal(warningHistory[0].event.message, "wake-warning-probe")
  const fakeBin = join(workspace, "bin")
  mkdirSync(fakeBin)
  const fake = join(fakeBin, "codex")
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
    PATH: fakeBin,
    LEUCO_VERIFY_TRACE: join(workspace, "trace.jsonl"),
    LEUCO_VERIFY_STDERR: "1",
    CODEX_HOME: join(workspace, "codex"),
  }
  const diagnosticSecret = "xoxb-synthetic-startup-diagnostic-token"
  writeFileSync(
    join(home, "daemon.log"),
    `${"old diagnostic context\n".repeat(1000)}${diagnosticSecret}\n`,
  )
  const failedStart = assertFailure(
    (
      await cli(["start", "--json"], 1, {
        ...agentEnvironment,
        PATH: join(workspace, "missing-bin"),
      })
    ).stderr,
    "OPERATION_FAILED",
  ).details
  assert.equal(failedStart.exitCode, 1)
  assert.equal(failedStart.signal, null)
  assert.equal(failedStart.logPath, join(home, "daemon.log"))
  assert.ok(failedStart.logTail.includes("codex"))
  assert.ok(failedStart.logTail.length <= 16_000)
  assert.equal(failedStart.logTailTruncated, true)
  assert.equal(JSON.stringify(failedStart).includes(diagnosticSecret), false)
  assert.ok(failedStart.logTail.includes("[redacted]"))
  assert.equal(failedStart.logReadFailure, null)
  const delayedEnvironment = { ...agentEnvironment, LEUCO_VERIFY_INIT_DELAY_MS: "20000" }
  try {
    const unconfirmed = assertFailure(
      (await cli(["start", "--json"], 5, delayedEnvironment)).stderr,
      "STATE_UNCERTAIN",
    ).details
    assert.equal(unconfirmed.phase, "readiness")
    assert.ok(unconfirmed.pid > 0)
    assert.equal(unconfirmed.lastStatus.ready, false)
    assert.ok(unconfirmed.probes > 0)
  } finally {
    await cli(["stop", "--json"], 0, delayedEnvironment).catch(() => {})
  }
  await cli(["start", "--json"], 0, agentEnvironment)
  try {
    const reply = assertSuccess(
      ["ask"],
      (await cli(["ask", "--json", "--", "--data-not-options"], 0, agentEnvironment)).stdout,
    )
    assert.equal(reply.reply, "verified reply")
  } finally {
    await cli(["stop", "--json"], 0, agentEnvironment)
  }
  const stderrHistory = assertSuccess(
    ["events"],
    (await cli(["events", "--type", "log", "--json"])).stdout,
  )
  assert.ok(
    stderrHistory.some(
      (entry: { event: { level: string; line: string } }) =>
        entry.event.level === "warn" && entry.event.line.includes("[redacted]"),
    ),
  )
  assert.equal(JSON.stringify(stderrHistory).includes("cli-stderr-token"), false)
  assertSuccess(["start"], (await cli(["start", "--json"], 0, agentEnvironment)).stdout)
  const maintenancePath = join(home, "maintenance.json")
  const maintenanceBeforeValidation = existsSync(maintenancePath)
    ? readFileSync(maintenancePath, "utf8")
    : null
  for (const probe of [
    { endpoint: "/turn", body: { text: "   " }, path: ["text"] },
    { endpoint: "/turn", body: { text: "unsupported override", model: "ignored-model" }, path: [] },
    { endpoint: "/restart", body: { model: "retired-override" }, path: [] },
    { endpoint: "/restart", body: { cwd: "relative/work" }, path: ["cwd"] },
    { endpoint: "/restart", body: { soul: "SOUL.md" }, path: ["soul"] },
    {
      endpoint: "/slack",
      body: { words: ["slack", "call", "auth.test"], flags: { body: 42 } },
      path: ["flags", "body"],
    },
  ]) {
    const rejectedTurn = await requestDaemon({
      home,
      path: probe.endpoint,
      body: probe.body,
      requestId: randomUUID(),
    }).catch((error: unknown) => error)
    assert.ok(rejectedTurn instanceof CliError && rejectedTurn.code === "USAGE")
    const rejectedDetails = z
      .object({
        phase: z.literal("validation"),
        executionStarted: z.literal(false),
        mutationMayHaveOccurred: z.literal(false),
        issues: z.array(z.object({ path: z.array(z.string()) })),
      })
      .parse(rejectedTurn.details)
    assert.deepEqual(rejectedDetails.issues[0]?.path, probe.path)
  }
  assert.equal(
    existsSync(maintenancePath) ? readFileSync(maintenancePath, "utf8") : null,
    maintenanceBeforeValidation,
  )
  const rejectedBody = await requestDaemon({
    home,
    path: "/turn",
    body: { text: "x".repeat(4 * 1024 * 1024) },
    requestId: randomUUID(),
  }).catch((error: unknown) => error)
  assert.ok(rejectedBody instanceof CliError && rejectedBody.code === "USAGE")
  z.object({
    phase: z.literal("control-body"),
    executionStarted: z.literal(false),
    mutationMayHaveOccurred: z.literal(false),
  }).parse(rejectedBody.details)
  const launchSnapshot = readFileSync(join(home, "launch.json"), "utf8")
  const originalLaunch = JSON.parse(launchSnapshot)
  writeFileSync(join(home, "launch.json"), JSON.stringify({ ...originalLaunch, soul: workspace }))
  const invalidPaths = assertFailure(
    (await cli(["doctor", "--json"], 1, agentEnvironment)).stderr,
    "CHECK_FAILED",
  ).details
  assert.equal(invalidPaths.soulExists, false)
  assert.equal(invalidPaths.codex, fake)
  assert.ok(invalidPaths.failures.some((failure: { phase: string }) => failure.phase === "soul"))
  writeFileSync(join(home, "launch.json"), launchSnapshot)
  const conflict = await cli(["start", "--json"], 3, agentEnvironment)
  assertFailure(conflict.stderr, "STATE_CONFLICT")
  assertSuccess(
    ["ask"],
    (await cli(["ask", "--json", "--", "--this-is-data"], 0, agentEnvironment)).stdout,
  )
  assertSuccess(["status"], (await cli(["status", "--json"], 0, agentEnvironment)).stdout)
  const stopped = JSON.parse((await cli(["stop", "--json"], 0, agentEnvironment)).stdout)
  const finalStderr = assertSuccess(
    ["events"],
    (await cli(["events", "--type", "log", "--json"])).stdout,
  )
  assert.ok(
    finalStderr.some(
      (entry: { event: { level: string; line: string } }) =>
        entry.event.level === "warn" &&
        entry.event.line.includes("final unterminated stderr marker"),
    ),
  )
  const shutdownHistory = assertSuccess(
    ["events"],
    (await cli(["events", "--request", stopped.requestId, "--type", "log", "--json"])).stdout,
  )
  assert.ok(
    shutdownHistory.some((entry: { event: { line: string } }) =>
      entry.event.line.includes("control request"),
    ),
  )
  const alternateCwd = join(workspace, "alternate-cwd")
  mkdirSync(alternateCwd)
  const signalDaemon = assertSuccess(
    ["start"],
    (await cli(["--cwd", alternateCwd, "start", "--json"], 0, agentEnvironment)).stdout,
  )
  assert.equal(signalDaemon.cwd, alternateCwd)
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
