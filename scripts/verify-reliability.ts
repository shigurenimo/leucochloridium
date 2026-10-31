import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import pkg from "leuco/package.json" with { type: "json" }
import { CliError } from "@/cli/cli-error"
import { handleDaemonRequest } from "@/daemon/handle-daemon-request"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { randomUUID } from "node:crypto"
import { LeucoCodexClient } from "@/engine/codex/codex-client"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { requestDaemon } from "@/daemon/request-daemon"
import { readLeucoEvents } from "@/events/read-leuco-events"
import { readDaemonLease, isProcessAlive } from "@/daemon/daemon-lease"
import { errorDetails } from "@/error-details"

const repository = resolve(import.meta.dir, "..")
const workspace = realpathSync(mkdtempSync("/tmp/leuco-reliability-"))
const home = join(workspace, "state")
const trace = join(workspace, "trace.jsonl")
const fakeBin = join(workspace, "bin")
mkdirSync(fakeBin)
const fake = join(fakeBin, "codex")
writeFileSync(
  fake,
  `#!/bin/sh\nexec '${process.execPath}' '${join(repository, "scripts/fixtures/fake-codex.ts")}' "$@"\n`,
  { mode: 0o700 },
)
const env = {
  ...process.env,
  PATH: fakeBin,
  LEUCO_HOME: home,
  LEUCO_VERIFY_TRACE: trace,
  LEUCO_VERIFY_CODEX: fake,
}
const cliPath = join(repository, "lib/index.ts")
const processes: Array<ReturnType<typeof Bun.spawn>> = []
const processContexts = new WeakMap<object, { command: string; home: string; pid: number }>()
const daemonHomes = new Set<string>([home])
const verification: { failure: unknown } = { failure: null }
function spawn(args: string[], stateHome = home, overrides: NodeJS.ProcessEnv = {}) {
  if (args[0] === "start") daemonHomes.add(stateHome)
  const child = Bun.spawn([process.execPath, cliPath, ...args, "--json"], {
    cwd: workspace,
    env: { ...env, ...overrides, LEUCO_HOME: stateHome },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  processes.push(child)
  processContexts.set(child, { command: args[0] ?? "fixture", home: stateHome, pid: child.pid })
  return child
}
async function result(
  child: {
    stdout: ReadableStream
    stderr: ReadableStream
    exited: Promise<number>
    kill: () => void
  },
  expected = 0,
) {
  const origin = new Error("CLI fixture observation started")
  const startedAt = performance.now()
  const observation = { watchdogExpired: false }
  const timeout = setTimeout(() => {
    observation.watchdogExpired = true
    child.kill()
  }, 8000)
  try {
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    assert.equal(
      await child.exited,
      expected,
      `${JSON.stringify({ ...processContexts.get(child), elapsedMs: Math.round(performance.now() - startedAt), watchdogExpired: observation.watchdogExpired })}\n${origin.stack}\n${stdout}\n${stderr}`,
    )
    return JSON.parse(expected === 0 ? stdout : stderr)
  } finally {
    clearTimeout(timeout)
  }
}
async function cli(args: string[], expected = 0) {
  return result(spawn(args), expected)
}
async function until<T>(read: () => Promise<T>, accept: (observation: T) => boolean): Promise<T> {
  const startedAt = performance.now()
  const pending = new Error("Runtime observation started here")
  const last: { observation: unknown; failure: unknown } = { observation: null, failure: null }
  while (performance.now() - startedAt < 5000) {
    try {
      const observed = await read()
      last.observation = observed
      if (accept(observed)) return observed
    } catch (error) {
      last.failure = error
    }
    await Bun.sleep(30)
  }
  throw new AggregateError(
    [pending, ...errorDetails(last.failure)],
    `Expected runtime observation did not arrive within 5s; last observation: ${JSON.stringify(last.observation)?.slice(0, 4000)}; last failure: ${JSON.stringify(errorDetails(last.failure))?.slice(0, 4000)}`,
    { cause: pending },
  )
}
try {
  const optionFailures: unknown[] = []
  for (const mode of ["args", "env", "onLog"]) {
    const optionTrace = join(workspace, `options-${mode}.jsonl`)
    const initialLogs: string[] = []
    const replacementLogs: string[] = []
    const options = {
      bin: process.execPath,
      args: [join(repository, "scripts/fixtures/fake-codex.ts")],
      env: { ...process.env, LEUCO_VERIFY_TRACE: optionTrace },
      onLog: (line: string) => {
        initialLogs.push(line)
      },
    }
    const optionClient = new LeucoCodexClient(options)
    if (mode === "args") options.args[0] = join(workspace, "missing-codex.ts")
    if (mode === "env") options.env.LEUCO_VERIFY_TRACE = join(workspace, "replacement-trace.jsonl")
    if (mode === "onLog")
      options.onLog = (line: string) => {
        replacementLogs.push(line)
      }
    try {
      for (const _ of [0, 1]) {
        await optionClient.start()
        assert.equal(optionClient.isRunning(), true)
        await optionClient.stop()
      }
      assert.equal(
        existsSync(optionTrace),
        true,
        `${mode}: caller mutation changed child environment`,
      )
      const requests = readFileSync(optionTrace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const initializations = requests.filter((request) => request.method === "initialize")
      assert.equal(initializations.length, 2)
      for (const initialized of initializations)
        assert.deepEqual(initialized.params.clientInfo, {
          name: "leuco",
          title: "leucochloridium",
          version: pkg.version,
        })
      assert.equal(
        initialLogs.filter((line) => line.includes("app-server ready")).length,
        2,
        `${mode}: caller mutation replaced log consumer`,
      )
      assert.equal(replacementLogs.length, 0)
    } catch (error) {
      optionFailures.push(error)
    } finally {
      await optionClient.stop()
    }
  }
  if (optionFailures.length)
    throw new AggregateError(optionFailures, "Codex client options changed after construction")
  const controlProbeLog = new LeucoEventLog()
  const longHistoryRequestId = `library-${"r".repeat(513)}`
  controlProbeLog.log("info", "retained library request", longHistoryRequestId)
  const controlProbeId = randomUUID()
  const controlProbeHome = join(workspace, "control-diagnostic")
  mkdirSync(controlProbeHome, { mode: 0o700 })
  writeFileSync(
    join(controlProbeHome, "daemon.json"),
    JSON.stringify({ pid: process.pid, token: "synthetic-control-probe" }),
    { mode: 0o600 },
  )
  writeFileSync(
    join(controlProbeHome, "launch.json"),
    JSON.stringify({ workingDirectory: workspace, codexHome: null }),
    { mode: 0o600 },
  )
  const deliveryHealth = {
    healthy: false,
    lastFailure: {
      ts: 1,
      message: "delivery failed",
      causes: [{ name: "Error", message: "stderr closed", stack: null, code: "EPIPE" }],
    },
  }
  const codexObservation = {
    codexRunning: true,
    codex: { starting: false, stopping: false, cleaningUp: false },
  }
  const restartAttempts = { count: 0 }
  const opaqueSlackActions = { count: 0 }
  const publicationProbe = { enabled: false }
  const hostLogHealth = { healthy: true }
  const scheduleHealth = { state: "ready" }
  const unreadableHistory = { enabled: false }
  const missingSqliteHistory = { enabled: false }
  const persistenceProbe = {
    mode: "memory-fallback",
    failedWrites: 1,
    lastWriteFailed: true,
    lastPersistError: { message: "database unavailable", causes: [{ code: "SQLITE_NOTADB" }] },
    lastReportError: { message: "stderr closed", causes: [{ code: "EPIPE" }] },
    lastCloseError: null,
  }
  const controlProbeSocket = join(controlProbeHome, "control.sock")
  const controlProbeServer = Bun.serve({
    unix: controlProbeSocket,
    fetch: handleDaemonRequest({
      token: "synthetic-control-probe",
      cwd: workspace,
      isReady: () => true,
      getRuntimeStatus: () => ({
        ...codexObservation,
        logConsumer: hostLogHealth,
        ...(missingSqliteHistory.enabled
          ? {
              logs: {
                ...persistenceProbe,
                mode: "sqlite",
                failedWrites: 0,
                lastWriteFailed: false,
                lastPersistError: null,
                lastReportError: null,
              },
            }
          : unreadableHistory.enabled
            ? { logs: persistenceProbe }
            : {}),
        connections: [
          {
            name: "slack",
            type: "slack",
            health: { state: "connected", diagnostics: deliveryHealth },
          },
          { name: "schedule", type: "schedule", health: scheduleHealth },
        ],
      }),
      restart: (_overrides, requestId) => {
        restartAttempts.count += 1
        if (publicationProbe.enabled) {
          new NodeMaintenanceStore(controlProbeHome).writeOperation({
            id: requestId,
            status: "accepted",
            requestedAt: Date.now(),
            updatedAt: Date.now(),
            workerPid: null,
            oldPid: process.pid,
            oldLeaseId: null,
            newPid: null,
            error: null,
            recovery: null,
            launch: { workingDirectory: workspace, codexHome: null },
          })
          const failure = new CliError("STATE_UNCERTAIN", "Worker publication was not verified", {
            phase: "worker-publication",
            journalWritten: true,
            operationId: requestId,
            workerPid: null,
          })
          failure.cause = Object.assign(new Error("injected publication failure"), { code: "EIO" })
          throw failure
        }
        throw new Error("Unexpected restart during Codex recovery")
      },
      runSlackCommand: async (_parsed, options) => {
        opaqueSlackActions.count += 1
        writeFileSync(
          join(workspace, "opaque-slack-effect.json"),
          JSON.stringify({ requestId: options?.requestId }),
          { mode: 0o600 },
        )
        return Response.json({ error: "injected service error after acceptance" }, { status: 503 })
      },
      getVolatileEvents: (query) => {
        if (query.requestId === longHistoryRequestId)
          return [...controlProbeLog.query({ ...query, order: "desc" })].reverse()
        throw Object.assign(new Error("injected history read failure"), { code: "EIO" })
      },
      reportError: (error, requestId) => {
        controlProbeLog.error("control probe failed", error, requestId)
        return "control probe failed"
      },
      runTextTurn: async () => "",
      stop: () => {},
    }),
  })
  try {
    const status = await result(spawn(["status"], controlProbeHome))
    assert.deepEqual(status.data.runtime.connections[0].health.diagnostics, deliveryHealth)
    const diagnosis = await result(spawn(["doctor"], controlProbeHome), 1)
    assert.ok(
      diagnosis.error.details.errors.some((message: string) =>
        message.includes("log delivery is degraded"),
      ),
    )
    assert.equal(
      diagnosis.error.details.daemon.runtime.connections[0].health.diagnostics.lastFailure.causes[0]
        .code,
      "EPIPE",
    )
    deliveryHealth.healthy = true
    const recovered = await result(spawn(["doctor"], controlProbeHome))
    assert.equal(recovered.data.healthy, true)
    assert.deepEqual(
      recovered.data.daemon.runtime.connections[0].health.diagnostics.lastFailure,
      deliveryHealth.lastFailure,
    )
    hostLogHealth.healthy = false
    const failedObserver = await result(spawn(["doctor"], controlProbeHome), 1)
    assert.ok(
      failedObserver.error.details.errors.some((issue: string) =>
        issue.includes("Runtime log consumer is degraded"),
      ),
    )
    const observerRepair = await result(spawn(["repair"], controlProbeHome))
    assert.equal(observerRepair.data.repaired, false)
    assert.equal(observerRepair.data.restart, null)
    hostLogHealth.healthy = true
    for (const phase of ["starting", "stopping", "cleaningUp"]) {
      codexObservation.codexRunning = false
      codexObservation.codex = {
        starting: false,
        stopping: false,
        cleaningUp: false,
        [phase]: true,
      }
      const repairing = await result(spawn(["repair"], controlProbeHome))
      assert.equal(repairing.data.repaired, false)
      assert.equal(repairing.data.restart, null)
      assert.ok(repairing.data.issues.some((issue: string) => issue.includes("observe status")))
      const observing = await result(spawn(["doctor"], controlProbeHome), 1)
      assert.ok(
        observing.error.details.errors.some((issue: string) => issue.includes("observe status")),
      )
    }
    assert.equal(restartAttempts.count, 0)
    codexObservation.codexRunning = true
    codexObservation.codex = { starting: false, stopping: false, cleaningUp: false }
    scheduleHealth.state = "error"
    const scheduleDiagnosis = await result(spawn(["doctor"], controlProbeHome), 1)
    assert.ok(
      scheduleDiagnosis.error.details.errors.some((issue: string) =>
        issue.includes("settings, storage and turn errors"),
      ),
    )
    const scheduleRepair = await result(spawn(["repair"], controlProbeHome))
    assert.equal(scheduleRepair.data.repaired, false)
    assert.equal(scheduleRepair.data.restart, null)
    assert.equal(restartAttempts.count, 0, "Schedule-only failure restarted a healthy transport")
    scheduleHealth.state = "ready"
    assert.equal((await result(spawn(["doctor"], controlProbeHome))).data.healthy, true)
    missingSqliteHistory.enabled = true
    try {
      const missing = await result(spawn(["doctor"], controlProbeHome), 1)
      assert.equal(missing.error.details.eventLogValid, false)
      assert.ok(JSON.stringify(missing.error.details.failures).includes("missing"))
      assert.equal(existsSync(join(controlProbeHome, "events.db")), false)
      const missingEvents = await result(spawn(["events"], controlProbeHome), 5)
      assert.equal(missingEvents.error.code, "STATE_UNCERTAIN")
      const historyRepair = await result(spawn(["repair"], controlProbeHome))
      assert.equal(historyRepair.data.repaired, false)
      assert.equal(historyRepair.data.restart, null)
      codexObservation.codexRunning = false
      try {
        const combinedRepair = await result(spawn(["repair"], controlProbeHome))
        assert.equal(combinedRepair.data.repaired, false)
        assert.equal(combinedRepair.data.restart, null)
        assert.equal(restartAttempts.count, 0, "Unverified event history triggered a restart")
      } finally {
        codexObservation.codexRunning = true
      }
    } finally {
      missingSqliteHistory.enabled = false
    }
    const response = await fetch("http://localhost/events", {
      unix: controlProbeSocket,
      headers: {
        authorization: "Bearer synthetic-control-probe",
        "x-leuco-request-id": controlProbeId,
      },
      signal: AbortSignal.timeout(2000),
    })
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), {
      error: "control probe failed",
      requestId: controlProbeId,
    })
    const recorded = controlProbeLog.query({ requestId: controlProbeId, limit: 10 })
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]?.event.requestId, controlProbeId)
    const longResponse = await fetch(
      `http://localhost/events?${new URLSearchParams({ requestId: longHistoryRequestId })}`,
      {
        unix: controlProbeSocket,
        headers: {
          authorization: "Bearer synthetic-control-probe",
          "x-leuco-request-id": controlProbeId,
        },
        signal: AbortSignal.timeout(2000),
      },
    )
    assert.equal(longResponse.status, 200)
    assert.deepEqual(
      await longResponse.json(),
      controlProbeLog.query({ requestId: longHistoryRequestId }),
    )
    unreadableHistory.enabled = true
    writeFileSync(join(controlProbeHome, "events.db"), "corrupt diagnostic database", {
      mode: 0o600,
    })
    const unreadable = await result(spawn(["events"], controlProbeHome), 5)
    assert.equal(unreadable.error.code, "STATE_UNCERTAIN")
    assert.equal(unreadable.error.details.phase, "saved-history")
    assert.equal(unreadable.error.details.livePhase, "volatile-history")
    assert.equal(unreadable.error.details.savedHistoryVerified, false)
    assert.equal(Object.hasOwn(unreadable.error.details, "savedEvents"), false)
    assert.deepEqual(unreadable.error.details.persistence, persistenceProbe)
    assert.ok(
      unreadable.error.details.causes.some(
        (cause: { code: string | null }) => cause.code === "SQLITE_NOTADB",
      ),
    )
    assert.ok(
      unreadable.error.details.causes.some((cause: { message: string }) =>
        cause.message.includes("control probe failed"),
      ),
    )
    const opaqueSlack = await result(
      spawn(["slack", "call", "auth.test", "--body", "{}"], controlProbeHome),
      5,
    )
    assert.equal(opaqueSlack.error.code, "STATE_UNCERTAIN")
    assert.equal(opaqueSlack.error.details.phase, "error-classification")
    assert.equal(opaqueSlack.error.details.status, 503)
    assert.equal(opaqueSlack.error.mutationMayHaveOccurred, true)
    assert.equal(
      JSON.parse(readFileSync(join(workspace, "opaque-slack-effect.json"), "utf8")).requestId,
      opaqueSlack.requestId,
    )
    assert.equal(opaqueSlackActions.count, 1, "Opaque Slack result was replayed")
    publicationProbe.enabled = true
    const unconfirmedRestart = await result(spawn(["restart"], controlProbeHome), 5)
    assert.equal(unconfirmedRestart.error.code, "STATE_UNCERTAIN")
    assert.equal(unconfirmedRestart.error.mutationMayHaveOccurred, true)
    assert.equal(unconfirmedRestart.error.details.phase, "worker-publication")
    assert.equal(unconfirmedRestart.error.details.journalWritten, true)
    assert.ok(
      unconfirmedRestart.error.details.causes.some(
        (cause: { code: string | null }) => cause.code === "EIO",
      ),
    )
    assert.equal(unconfirmedRestart.error.details.operationId, unconfirmedRestart.requestId)
    assert.equal(
      new NodeMaintenanceStore(controlProbeHome).readOperation()?.id,
      unconfirmedRestart.requestId,
    )
    assert.equal(restartAttempts.count, 1, "Unconfirmed restart was replayed")
  } finally {
    await controlProbeServer.stop(true)
    controlProbeLog.close()
  }
  const diagnosticProbe = Bun.spawn(
    [
      process.execPath,
      "-e",
      [
        `import { writeCliError } from ${JSON.stringify(join(repository, "lib/cli/write-cli-error.ts"))}`,
        "const failure = Proxy.revocable({}, {})",
        "failure.revoke()",
        'await writeCliError(failure.proxy, ["status", "--json"], { requestId: "d7775438-bb13-4885-8a6d-12fcd5adf4c9" })',
      ].join("\n"),
    ],
    { cwd: workspace, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  processes.push(diagnosticProbe)
  const diagnosticFailure = await result(diagnosticProbe, 1)
  assert.equal(diagnosticFailure.ok, false)
  assert.equal(diagnosticFailure.error.code, "OPERATION_FAILED")
  assert.equal(diagnosticFailure.error.message, "[unprintable thrown value]")
  assert.ok(diagnosticFailure.error.details.causes.length > 0)
  const legacyPath = join(workspace, "legacy-events.db")
  const legacyDatabase = new Database(legacyPath)
  try {
    legacyDatabase.run(
      "CREATE TABLE logs (seq INTEGER PRIMARY KEY, ts REAL, type TEXT, event TEXT)",
    )
    const legacyEvents = [
      { ts: 10, type: "tenant.started", project: "old", requestId: "legacy" },
      { ts: 20, type: "runtime.started", runtime: "leuco", requestId: "modern" },
      { ts: 30, type: "tenant.stopped", project: "old", requestId: "legacy" },
      { ts: 40, type: "log", level: "info", line: "noise" },
    ]
    for (const event of legacyEvents)
      legacyDatabase
        .query("INSERT INTO logs (ts, type, event) VALUES (?, ?, ?)")
        .run(event.ts, event.type, JSON.stringify(event))
  } finally {
    legacyDatabase.close()
  }
  assert.deepEqual(
    readLeucoEvents(legacyPath, 10, { type: "runtime.started" }).map((entry) => entry.seq),
    [2, 1],
  )
  assert.deepEqual(
    readLeucoEvents(legacyPath, 1, {
      type: "runtime.started",
      requestId: "legacy",
      summary: true,
    }).map((entry) => entry.seq),
    [1],
  )
  assert.deepEqual(
    readLeucoEvents(legacyPath, 1, { type: "runtime.stopped", since: 25 }).map(
      (entry) => entry.seq,
    ),
    [3],
  )
  for (const type of ["__proto__", "constructor", "toString", "unknown.event"])
    assert.deepEqual(readLeucoEvents(legacyPath, 10, { type }), [])
  const textLogHome = join(workspace, "text-log-failure")
  await result(spawn(["start"], textLogHome, { LEUCO_VERIFY_STDERR: "1" }))
  try {
    const initial = (await result(spawn(["status"], textLogHome))).data
    renameSync(join(textLogHome, "daemon.log"), join(workspace, "saved-text-log"))
    mkdirSync(join(textLogHome, "daemon.log"))
    process.kill(initial.runtime.codex.pid, "SIGKILL")
    await until(
      async () => (await result(spawn(["status"], textLogHome))).data,
      (status) => status.runtime.codexRunning === false,
    )
    await result(spawn(["ask", "text log diagnosis"], textLogHome))
    const failedLog = (await result(spawn(["status"], textLogHome))).data.runtime.textLog
    assert.equal(failedLog.healthy, false)
    assert.ok(
      failedLog.lastFailure.causes.some((cause: { code: string }) =>
        ["EISDIR", "ENOTDIR"].includes(cause.code),
      ),
    )
    assert.ok(!JSON.stringify(failedLog).includes("xoxb-synthetic"))
    const textFailures = (await result(spawn(["events", "--type", "log"], textLogHome))).data
    assert.ok(
      textFailures.some((entry: { event: { causes?: Array<{ code: string | null }> } }) =>
        entry.event.causes?.some((cause) => cause.code === "EISDIR" || cause.code === "ENOTDIR"),
      ),
    )
    await result(spawn(["doctor"], textLogHome), 1)
    const beforeRecovery = (await result(spawn(["status"], textLogHome))).data
    rmSync(join(textLogHome, "daemon.log"), { recursive: true })
    process.kill(beforeRecovery.runtime.codex.pid, "SIGKILL")
    await until(
      async () => (await result(spawn(["status"], textLogHome))).data,
      (status) => status.runtime.codexRunning === false,
    )
    await result(spawn(["ask", "text log recovered"], textLogHome))
    const recoveredLog = (await result(spawn(["status"], textLogHome))).data.runtime.textLog
    assert.equal(recoveredLog.healthy, true)
    assert.deepEqual(recoveredLog.lastFailure, failedLog.lastFailure)
    assert.equal(recoveredLog.lastErrorAt, failedLog.lastErrorAt)
    await result(spawn(["doctor"], textLogHome))
  } finally {
    rmSync(join(textLogHome, "daemon.log"), { recursive: true, force: true })
    await result(spawn(["stop"], textLogHome)).catch(() => {})
  }
  await cli(["start"])
  const first = (await cli(["status"])).data
  const oversizedId = randomUUID()
  const rejectedBody = await requestDaemon({
    home,
    path: "/turn",
    requestId: oversizedId,
    body: { text: "x".repeat(4 * 1024 * 1024) },
    timeoutMs: 5000,
  }).catch((error: unknown) => error)
  assert.ok(errorDetails(rejectedBody).some((cause) => cause.message.includes("4194304")))
  const controlLease = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"))
  const stalledId = randomUUID()
  const stalledReply = await fetch("http://localhost/turn", {
    unix: join(home, "control.sock"),
    method: "POST",
    signal: AbortSignal.timeout(8000),
    headers: {
      authorization: `Bearer ${controlLease.token}`,
      "x-leuco-request-id": stalledId,
      "content-type": "application/json",
    },
    body: new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"text":"'))
      },
    }),
  })
  assert.equal(stalledReply.status, 400)
  assert.match(await stalledReply.text(), /receive timed out/)
  for (const requestId of [oversizedId, stalledId]) {
    const rejectedHistory = (await cli(["events", "--request", requestId])).data
    assert.ok(
      !rejectedHistory.some((entry: { event: { type: string } }) =>
        ["turn.queued", "turn.start"].includes(entry.event.type),
      ),
    )
  }
  for (const attempt of [1, 2, 3, 4, 5]) {
    const held = spawn(["ask", "hold"])
    const active = await until(
      async () => (await cli(["status"])).data,
      (status) => status.runtime.active !== null,
    )
    assert.ok(active.runtime.codex.pid > 0)
    await until(
      async () =>
        readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter(
            (frame) =>
              frame.method === "turn/start" &&
              frame.params.input?.some((entry: { text?: string }) => entry.text === "hold"),
          ).length,
      (count) => count === attempt,
    )
    process.kill(active.runtime.codex.pid, "SIGKILL")
    const failed = await result(held, 1)
    assert.equal(failed.requestId, active.runtime.active.requestId)
    const events = (await cli(["events", "--request", failed.requestId])).data
    assert.ok(
      events.some(
        (entry: { event: { type: string; causes?: unknown[] } }) =>
          entry.event.type === "turn.error" && (entry.event.causes?.length ?? 0) > 0,
      ),
    )
    const next = await cli(["ask", `recovery-${attempt}`])
    assert.equal(next.data.reply, "verified reply")
    assert.equal(
      (await cli(["status"])).data.runtime.instanceId,
      first.runtime.instanceId,
      "Codex crash took the daemon down",
    )
  }
  const intactDiagnosis = (await cli(["doctor"])).data
  assert.equal(intactDiagnosis.healthy, true)
  assert.equal(
    intactDiagnosis.hints.some((hint: string) => hint.includes("history may have gaps")),
    false,
  )
  const database = new Database(join(home, "events.db"))
  database.exec("BEGIN IMMEDIATE")
  try {
    const lockedRequest = await cli(["ask", "sink-locked"])
    assert.equal(lockedRequest.data.reply, "verified reply")
    const missingHistory = await cli(["events", "--request", lockedRequest.requestId], 5)
    assert.equal(missingHistory.error.code, "STATE_UNCERTAIN")
    assert.equal(missingHistory.error.details.phase, "history-persistence")
    assert.equal(missingHistory.error.details.savedEvents.length, 0)
    assert.ok(missingHistory.error.details.persistence.failedWrites > 0)
    assert.equal(missingHistory.error.details.persistence.lastReportError, null)
    assert.equal(missingHistory.error.details.persistence.lastCloseError, null)
    const status = (await cli(["status"])).data
    assert.equal(status.runtime.logs.lastWriteFailed, true)
    assert.ok(
      status.runtime.logs.lastPersistError.causes.some(
        (cause: { code: string | null }) => cause.code === "SQLITE_BUSY",
      ),
    )
    const diagnosis = await cli(["doctor"], 1)
    assert.ok(
      diagnosis.error.details.errors.some((message: string) =>
        message.includes("Event persistence"),
      ),
    )
  } finally {
    database.exec("ROLLBACK")
    database.close()
  }
  const recoveredRequest = await cli(["ask", "sink-recovered"])
  const partialHistory = await cli(["events", "--request", recoveredRequest.requestId], 5)
  assert.equal(partialHistory.error.details.phase, "history-persistence")
  assert.equal(partialHistory.error.details.persistence.lastWriteFailed, false)
  assert.ok(
    partialHistory.error.details.savedEvents.some(
      (entry: { event: { type: string } }) => entry.event.type === "turn.complete",
    ),
  )
  const recoveredPersistence = (await cli(["status"])).data.runtime.logs
  assert.equal(recoveredPersistence.lastWriteFailed, false)
  assert.ok(
    recoveredPersistence.lastPersistError.causes.some(
      (cause: { code: string | null }) => cause.code === "SQLITE_BUSY",
    ),
  )
  const recoveredDiagnosis = (await cli(["doctor"])).data
  assert.equal(recoveredDiagnosis.healthy, true)
  assert.ok(recoveredDiagnosis.hints.some((hint: string) => hint.includes("history may have gaps")))
  const frames = readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.equal(
    frames.filter(
      (frame) =>
        frame.method === "turn/start" &&
        frame.params.input?.some((entry: { text?: string }) => entry.text === "hold"),
    ).length,
    5,
    "Failed prompts were replayed",
  )
  await cli(["stop"])
  assert.equal(isProcessAlive(first.pid), false)
  writeFileSync(
    join(home, "daemon.json"),
    JSON.stringify({ pid: process.pid, token: randomUUID() }),
  )
  try {
    const startedAt = Date.now()
    const incomplete = await cli(["events"], 5)
    assert.equal(incomplete.error.code, "STATE_UNCERTAIN")
    assert.equal(incomplete.error.mutationMayHaveOccurred, false)
    assert.ok(incomplete.error.details.savedEvents.length > 0)
    assert.equal(incomplete.error.details.liveHistoryVerified, false)
    assert.ok(
      Date.now() - startedAt < 2000,
      "Saved history was blocked by unavailable daemon control",
    )
  } finally {
    rmSync(join(home, "daemon.json"))
  }

  for (const mode of ["throw", "reject", "null", "unprintable", "metadata", "recover"]) {
    const faultHome = join(workspace, mode)
    daemonHomes.add(faultHome)
    const child = Bun.spawn(
      [process.execPath, join(repository, "scripts/fixtures/fault-daemon.ts")],
      {
        cwd: workspace,
        env: {
          ...env,
          LEUCO_HOME: faultHome,
          LEUCO_VERIFY_OWNS_PROCESS: mode === "recover" ? "1" : "0",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    processes.push(child)
    const ready = await until(
      async () => requestDaemon({ home: faultHome, path: "/status", timeoutMs: 200 }),
      (status) =>
        typeof status === "object" && status !== null && "ready" in status && status.ready === true,
    )
    assert.ok(typeof ready === "object" && ready !== null && "runtime" in ready)
    child.stdin.write(`${mode}\n`)
    const outcome = await result(child, 1)
    assert.match(
      outcome.error.message,
      mode === "null"
        ? /asynchronous failure: null/
        : mode === "unprintable"
          ? /asynchronous failure: \[unprintable thrown value\]/
          : /injected asynchronous failure/,
    )
    if (mode !== "null" && mode !== "unprintable")
      assert.ok(JSON.stringify(outcome).includes("injected root cause"))
    assert.equal(JSON.stringify(outcome).includes("xoxb-reliability-secret"), false)
    if (mode === "metadata") {
      assert.ok(JSON.stringify(outcome).includes("[unreadable code]"))
      assert.ok(!JSON.stringify(outcome).includes("private metadata accessor failure"))
    }
    const events = readLeucoEvents(join(faultHome, "events.db"), 100)
    assert.ok(
      events.some(
        (entry) =>
          entry.event.type === "log" &&
          entry.event.level === "error" &&
          entry.event.causes?.some((cause) =>
            cause.message.includes(
              mode === "null"
                ? "null"
                : mode === "unprintable"
                  ? "[unprintable thrown value]"
                  : "injected root cause",
            ),
          ),
      ),
    )
    if (mode === "recover") {
      const recovered = await until(
        async () => (await result(spawn(["status"], faultHome))).data,
        (status) => status.ready === true && status.maintenance?.status === "ready",
      )
      assert.equal(recovered.maintenance.id, outcome.requestId)
      assert.equal(recovered.maintenance.recovery.attempt, 1)
      assert.equal(
        (await result(spawn(["ask", "after fatal recovery"], faultHome))).data.reply,
        "verified reply",
      )
      await result(spawn(["stop"], faultHome))
    } else assert.equal(existsSync(join(faultHome, "daemon.json")), false)
  }
  const degradedHome = join(workspace, "degraded")
  mkdirSync(degradedHome)
  writeFileSync(join(degradedHome, "events.db"), "corrupt-event-database-sentinel")
  await result(spawn(["start"], degradedHome))
  if (process.env.LEUCO_VERIFY_FAIL_AFTER_DEGRADED_START === "1")
    throw new Error(`Injected fixture cleanup failure after start: ${degradedHome}`)
  const degraded = (await result(spawn(["status"], degradedHome))).data
  assert.equal(degraded.runtime.logs.mode, "memory-fallback")
  assert.equal(degraded.runtime.logs.lastWriteFailed, true)
  const answer = await result(spawn(["ask", "continue despite unavailable event DB"], degradedHome))
  assert.equal(answer.data.reply, "verified reply")
  const history = (await result(spawn(["events", "--request", answer.requestId], degradedHome)))
    .data
  assert.ok(
    history.some((entry: { event: { type: string } }) => entry.event.type === "turn.complete"),
  )
  const summaryHistory = (
    await result(
      spawn(["events", "--summary", "--request", answer.requestId, "--limit", "3"], degradedHome),
    )
  ).data
  assert.ok(
    summaryHistory.some(
      (entry: { event: { type: string } }) => entry.event.type === "turn.complete",
    ),
  )
  assert.ok(
    summaryHistory.every(
      (entry: { event: { type: string; level?: string } }) =>
        entry.event.type !== "codex.notification" &&
        !(entry.event.type === "log" && entry.event.level === "info"),
    ),
  )
  assert.ok(
    readFileSync(join(degradedHome, "daemon.log"), "utf8").includes(answer.requestId),
    "Volatile events were not mirrored to bounded text logs",
  )
  const savedFallbackLog = join(workspace, "saved-fallback-log")
  renameSync(join(degradedHome, "daemon.log"), savedFallbackLog)
  mkdirSync(join(degradedHome, "daemon.log"))
  try {
    const unmirrored = await result(spawn(["ask", "memory survives failed mirror"], degradedHome))
    assert.equal(unmirrored.data.reply, "verified reply")
    const failedMirror = (await result(spawn(["status"], degradedHome))).data.runtime
    assert.ok(failedMirror.logs.memoryWrites > degraded.runtime.logs.memoryWrites)
    assert.ok(
      failedMirror.logs.lastPersistError.causes.some(
        (cause: { code: string | null }) => cause.code === "EISDIR" || cause.code === "ENOTDIR",
      ),
    )
    assert.equal(failedMirror.textLog.healthy, false)
    const retained = (
      await result(spawn(["events", "--request", unmirrored.requestId], degradedHome))
    ).data
    assert.ok(
      retained.some((entry: { event: { type: string } }) => entry.event.type === "turn.complete"),
    )
  } finally {
    rmSync(join(degradedHome, "daemon.log"), { recursive: true, force: true })
    renameSync(savedFallbackLog, join(degradedHome, "daemon.log"))
  }
  const remirrored = await result(spawn(["ask", "mirror recovered"], degradedHome))
  assert.ok(readFileSync(join(degradedHome, "daemon.log"), "utf8").includes(remirrored.requestId))
  const recoveredMirror = (await result(spawn(["status"], degradedHome))).data.runtime
  assert.equal(recoveredMirror.textLog.healthy, true)
  assert.ok(
    recoveredMirror.logs.lastPersistError.causes.some(
      (cause: { code: string | null }) => cause.code === "EISDIR" || cause.code === "ENOTDIR",
    ),
  )
  await result(spawn(["doctor"], degradedHome), 1)
  await result(spawn(["stop"], degradedHome))
  assert.equal(
    readFileSync(join(degradedHome, "events.db"), "utf8"),
    "corrupt-event-database-sentinel",
  )
  const logs: string[] = []
  const client = new LeucoCodexClient({
    bin: fake,
    cwd: workspace,
    env: { ...env, LEUCO_VERIFY_INIT_DELAY_MS: "100" },
    onLog: (line) => {
      logs.push(line)
    },
    onAnyNotification: () => {
      throw new Error("notification consumer failed")
    },
  })
  try {
    const starting = client.start()
    const concurrent = client.start().then(() => {
      assert.equal(client.getStatus().ready, true)
    })
    await Promise.all([starting, concurrent])
    const thread = await client.startThread({ cwd: workspace })
    assert.ok(!(thread instanceof Error))
    assert.equal(await client.runTextTurn(thread.thread.id, "observer isolation"), "verified reply")
    assert.ok(logs.some((line) => line.includes("notification consumer failed")))
    await Promise.all([client.stop(), client.stop()])
    const interrupted = client.start().then(
      () => "unexpected success",
      (error) => error,
    )
    await until(
      async () => client.getStatus(),
      (status) => status.starting && status.pid !== null,
    )
    await client.stop()
    assert.ok((await interrupted) instanceof Error)
    assert.equal(client.isRunning(), false)
    await client.start()
    assert.equal(client.isRunning(), true)
  } finally {
    await client.stop()
  }
  console.log(
    "Reliability passed: 5 native Codex crashes/reconnections without replay, real SQLite write lock and recovery, fatal exception/rejection recording and orderly shutdown",
  )
} catch (error) {
  verification.failure = error
} finally {
  const cleanupFailures: unknown[] = []
  for (const stateHome of daemonHomes) {
    try {
      const lease = readDaemonLease(stateHome)
      if (lease === null || !isProcessAlive(lease.pid)) continue
      assert.notEqual(lease.pid, process.pid, "Refusing to stop the verifier itself")
      await result(spawn(["stop"], stateHome))
      assert.equal(isProcessAlive(lease.pid), false, `Fixture daemon still alive: ${lease.pid}`)
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  for (const child of processes) if (child.exitCode === null) child.kill()
  const cleanupTimer = setTimeout(() => {
    for (const child of processes) if (child.exitCode === null) child.kill("SIGKILL")
  }, 3000)
  try {
    await Promise.allSettled(processes.map((child) => child.exited))
  } finally {
    clearTimeout(cleanupTimer)
  }
  if (cleanupFailures.length === 0) {
    try {
      rmSync(workspace, { recursive: true, force: true })
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  if (cleanupFailures.length > 0)
    verification.failure = new AggregateError(
      [...(verification.failure === null ? [] : [verification.failure]), ...cleanupFailures],
      `Native fixture cleanup unconfirmed; preserving workspace: ${workspace}`,
    )
}
if (verification.failure !== null) throw verification.failure
