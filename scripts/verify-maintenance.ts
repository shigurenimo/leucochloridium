import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { recordMaintenanceOperation } from "@/maintenance/record-maintenance-operation"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import { requestDaemon } from "@/daemon/request-daemon"
import assert from "node:assert/strict"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  renameSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { scheduleRestart } from "@/maintenance/schedule-restart"
import { isProcessAlive } from "@/daemon/daemon-lease"
import { appendDaemonLog } from "@/daemon/append-daemon-log"
import { createConnection } from "node:net"

const repository = resolve(import.meta.dir, "..")
const workspace = realpathSync(mkdtempSync("/tmp/leuco-maint-"))
const home = join(workspace, "state")
const codexHome = join(workspace, "codex")
mkdirSync(codexHome)
writeFileSync(join(codexHome, "auth.json"), "native-auth-sentinel")
const fakeBin = join(workspace, "bin")
mkdirSync(fakeBin)
const fake = join(fakeBin, "codex")
writeFileSync(
  fake,
  `#!/bin/sh\nexec '${process.execPath}' '${join(repository, "scripts/fixtures/fake-codex.ts")}' "$@"\n`,
  { mode: 0o700 },
)
const trace = join(workspace, "trace.jsonl")
const env = {
  ...process.env,
  PATH: fakeBin,
  LEUCO_HOME: home,
  CODEX_HOME: codexHome,
  LEUCO_VERIFY_TRACE: trace,
}
const executable = join(repository, "lib/index.ts")
async function cli(args: string[], code: number | ReadonlyArray<number> = 0, stateHome = home) {
  const child = Bun.spawn([process.execPath, executable, ...args, "--json"], {
    cwd: workspace,
    env: { ...env, LEUCO_HOME: stateHome },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 20000)
  try {
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    const actualCode = await child.exited
    assert.ok(
      typeof code === "number" ? actualCode === code : code.includes(actualCode),
      `${args.join(" ")}\n${stdout}\n${stderr}`,
    )
    return JSON.parse(actualCode === 0 ? stdout : stderr)
  } finally {
    clearTimeout(timer)
  }
}
async function readyAfter(pid: number | null, operationId: string) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const status = (await cli(["status"])).data
      if (
        status.ready &&
        status.pid !== pid &&
        status.maintenance?.id === operationId &&
        status.maintenance.status === "ready"
      )
        return status
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error(
    `Readiness not observed: ${readFileSync(join(home, "maintenance.json"), "utf8")}\n${readFileSync(join(home, "daemon.log"), "utf8").slice(-4000)}`,
  )
}
try {
  await cli(["start", "--no-soul"])
  const before = (await cli(["status"])).data
  assert.equal(before.runtime.codexRunning, true)
  const wrongIdentity = await requestDaemon({
    home,
    path: "/stop",
    body: {},
    expectedLease: { pid: before.pid, token: randomUUID() },
  }).then(
    () => null,
    (error) => error,
  )
  assert.ok(wrongIdentity instanceof Error && wrongIdentity.message.includes("identity changed"))
  assert.equal((await cli(["status"])).data.runtime.instanceId, before.runtime.instanceId)

  const held = Bun.spawn([process.execPath, executable, "ask", "hold", "--json"], {
    cwd: workspace,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const activeDeadline = Date.now() + 5000
  const active: { requestId: string | null } = { requestId: null }
  while (Date.now() < activeDeadline) {
    const status = (await cli(["status"])).data
    if (status.runtime.active) {
      active.requestId = status.runtime.active.requestId
      break
    }
    await Bun.sleep(20)
  }
  assert.ok(active.requestId)
  const lease = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"))
  const uploadId = randomUUID()
  const incompleteUpload = createConnection(join(home, "control.sock"))
  incompleteUpload.on("error", () => {})
  incompleteUpload.on("data", () => {})
  const observed = await (async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        incompleteUpload.once("connect", resolve)
        incompleteUpload.once("error", reject)
      })
      incompleteUpload.write(
        `POST /slack HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${lease.token}\r\nX-Leuco-Request-Id: ${uploadId}\r\nContent-Type: multipart/form-data; boundary=probe\r\nContent-Length: 1000\r\n\r\n--probe\r\n`,
      )
      const receiveDeadline = performance.now() + 3000
      const receiving = { confirmed: false }
      while (performance.now() < receiveDeadline) {
        const status = (await cli(["status"])).data
        if (status.runtime.control.pendingRequests >= 3) {
          receiving.confirmed = true
          break
        }
        await Bun.sleep(20)
      }
      assert.equal(receiving.confirmed, true)
      const restart = (await cli(["restart"])).data
      assert.equal(restart.status, "accepted")
      assert.equal(
        scheduleRestart(home).id,
        restart.id,
        "Repeated requests created a second restart worker",
      )
      return { restart, after: await readyAfter(before.pid, restart.id) }
    } finally {
      incompleteUpload.destroy()
    }
  })()
  const restart = observed.restart
  const after = observed.after
  assert.notEqual(after.runtime.instanceId, before.runtime.instanceId)
  assert.equal(after.runtime.queue.waiting, 0)
  const maintenanceEvents = (await cli(["events", "--request", restart.id])).data
  const shutdownEvents = (await cli(["events", "--limit", "100"])).data.filter(
    (entry: { event: { type: string; line?: string } }) =>
      entry.event.type === "log" &&
      (entry.event.line?.includes("Control server") ||
        entry.event.line?.includes("Daemon shutdown requested")),
  )
  assert.ok(
    maintenanceEvents.some(
      (entry: {
        event: { type: string; level?: string; line?: string; causes?: Array<{ message: string }> }
      }) =>
        entry.event.type === "log" &&
        entry.event.level === "warn" &&
        entry.event.line?.includes("Control server force-closed") &&
        entry.event.causes?.some((cause) => cause.message.includes("graceful drain")),
    ),
    JSON.stringify({ operationId: restart.id, events: shutdownEvents }),
  )
  const interrupted = (await cli(["events", "--request", uploadId])).data
  assert.ok(
    interrupted.some(
      (entry: {
        event: { type: string; level?: string; line?: string; causes?: Array<{ message: string }> }
      }) =>
        entry.event.type === "log" &&
        entry.event.level === "warn" &&
        entry.event.line?.includes("Daemon request failed") &&
        (entry.event.causes?.length ?? 0) > 0,
    ),
  )
  assert.ok(
    maintenanceEvents.some(
      (entry: { event: { type: string; status: string } }) =>
        entry.event.type === "maintenance" && entry.event.status === "ready",
    ),
  )
  assert.equal((await cli(["doctor"])).data.versions.flume, "0.12.0")
  await held.exited
  const heldError = JSON.parse(await new Response(held.stderr).text())
  assert.equal(heldError.requestId, active.requestId)
  const history = (await cli(["events", "--request", active.requestId!])).data
  assert.ok(history.some((entry: { event: { type: string } }) => entry.event.type === "turn.start"))
  assert.ok(history.some((entry: { event: { type: string } }) => entry.event.type === "turn.error"))
  assert.ok(
    history.every(
      (entry: { event: { requestId: string } }) => entry.event.requestId === active.requestId,
    ),
  )
  await cli(["repair"])
  await cli(["stop"])
  const deadDeadline = Date.now() + 3000
  while (isProcessAlive(after.pid) && Date.now() < deadDeadline) await Bun.sleep(20)
  assert.equal(isProcessAlive(after.pid), false)
  const savedMaintenance = readFileSync(join(home, "maintenance.json"), "utf8")
  try {
    for (const status of ["accepted", "stopping", "starting", "uncertain"]) {
      writeFileSync(
        join(home, "maintenance.json"),
        JSON.stringify({ ...JSON.parse(savedMaintenance), status, workerPid: process.pid }),
      )
      const diagnosis = (await cli(["doctor"], 1)).error.details
      assert.equal(diagnosis.maintenance.workerAlive, true)
      assert.ok(
        diagnosis.errors.some((message: string) =>
          message.includes("maintenance is active or unverified"),
        ),
      )
      assert.ok(!diagnosis.errors.some((message: string) => message.includes("Run leuco start")))
    }
    writeFileSync(
      join(home, "maintenance.json"),
      JSON.stringify({ ...JSON.parse(savedMaintenance), status: "accepted", workerPid: null }),
    )
    const abandoned = (await cli(["doctor"], 1)).error.details
    assert.equal(abandoned.maintenance.status, "uncertain")
    assert.equal(abandoned.maintenance.workerAlive, false)
    assert.ok(!abandoned.errors.some((message: string) => message.includes("Run leuco start")))
    writeFileSync(join(home, "maintenance.json"), "invalid-journal-sentinel")
    const unreadable = (await cli(["doctor"], 1)).error.details
    assert.equal(unreadable.maintenance.status, "unreadable")
    assert.ok(!unreadable.errors.some((message: string) => message.includes("Run leuco start")))
  } finally {
    writeFileSync(join(home, "maintenance.json"), savedMaintenance)
  }
  const stopped = (await cli(["doctor"], 1)).error.details
  assert.ok(stopped.errors.some((message: string) => message.includes("Run leuco start")))
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: after.pid, token: randomUUID() }))
  writeFileSync(join(home, "control.sock"), "stale")
  const repaired = (await cli(["repair"])).data
  assert.ok(repaired.actions.some((action: string) => action.includes("stale")))
  assert.equal(existsSync(join(home, "daemon.json")), false)
  assert.equal(existsSync(join(home, "control.sock")), false)
  writeFileSync(join(home, "state.json"), "invalid-state-sentinel")
  const invalid = await cli(["doctor"], 1)
  assert.equal(invalid.error.details.stateValid, false)
  await cli(["repair"], 3)
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), "invalid-state-sentinel")
  await cli(["repair", "--reset-state"])
  const backup = readdirSync(home).find((name) => name.startsWith("state.invalid."))!
  assert.equal(readFileSync(join(home, backup), "utf8"), "invalid-state-sentinel")
  assert.deepEqual(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).threads, {})
  writeFileSync(
    join(home, "daemon.log"),
    `${"x".repeat(16380)} xoxb-synthetic-log-token ${"x".repeat(4 * 1024 * 1024)}\nrotated-log-marker\n`,
  )
  appendDaemonLog(home, "rotation-check")
  assert.ok(existsSync(join(home, "daemon.log.1")))
  assert.ok(readFileSync(join(home, "daemon.log"), "utf8").includes("rotation-check"))
  const recentLogs = (await cli(["logs", "--limit", "2"])).data.lines
  assert.equal(recentLogs.length, 2)
  assert.equal(recentLogs[0], "rotated-log-marker")
  assert.match(recentLogs[1], /rotation-check/)
  const longLogs = (await cli(["logs", "--limit", "3"])).data.lines
  assert.ok(longLogs[0].length < 16500)
  assert.match(longLogs[0], /truncated log line/)
  assert.ok(!longLogs.join("\n").includes("xox"), "A token prefix leaked at the clipping boundary")
  const savedCurrentLog = join(workspace, "saved-current-log")
  renameSync(join(home, "daemon.log"), savedCurrentLog)
  assert.deepEqual((await cli(["logs", "--limit", "1"])).data.lines, ["rotated-log-marker"])
  renameSync(savedCurrentLog, join(home, "daemon.log"))
  const privateFixture = join(workspace, "private-log-target")
  writeFileSync(privateFixture, "private-source-sentinel")
  symlinkSync(privateFixture, join(home, "daemon.log.2"))
  for (const targetPresent of [true, false]) {
    if (!targetPresent) rmSync(privateFixture)
    const partial = await cli(["logs", "--limit", "4"], 5)
    assert.equal(partial.error.code, "STATE_UNCERTAIN")
    assert.equal(partial.error.details.phase, "log-read")
    assert.equal(partial.error.details.generation, "daemon.log.2")
    assert.equal(partial.error.details.historyComplete, false)
    assert.deepEqual(partial.error.details.savedLines, longLogs)
    assert.ok(partial.error.details.causes.length > 0)
    assert.ok(!JSON.stringify(partial).includes("private-source-sentinel"))
    assert.ok(!JSON.stringify(partial).includes("xoxb-synthetic-log-token"))
  }
  assert.equal((await cli(["logs", "--limit", "1"])).data.lines.length, 1)
  rmSync(join(home, "daemon.log.2"))
  appendDaemonLog(
    home,
    "framing-first\nforged-log-record\rhidden\u001b[2J xoxb-synthetic-framing-token",
  )
  const framedLog = readFileSync(join(home, "daemon.log"), "utf8")
  assert.equal(framedLog.trimEnd().split("\n").length, 2)
  assert.ok(framedLog.includes("\\nforged-log-record"))
  assert.ok(!framedLog.includes("\r") && !framedLog.includes("\u001b"))
  assert.ok(!framedLog.includes("synthetic-framing-token"))
  appendDaemonLog(home, "x".repeat(17000))
  assert.match((await cli(["logs", "--limit", "1"])).data.lines[0], /truncated log entry/)
  const restarted = (await cli(["restart"])).data
  await readyAfter(null, restarted.id)
  renameSync(fake, `${fake}.unavailable`)
  try {
    const failedRestart = (await cli(["restart"])).data
    const failureDeadline = Date.now() + 12000
    const failed: { value: Record<string, unknown> | null } = { value: null }
    while (Date.now() < failureDeadline) {
      const operation = JSON.parse(readFileSync(join(home, "maintenance.json"), "utf8"))
      if (operation.id === failedRestart.id && operation.status === "failed") {
        failed.value = operation
        break
      }
      await Bun.sleep(100)
    }
    assert.ok(failed.value, "Replacement startup failure was not recorded")
    assert.ok(typeof failed.value.error === "string")
    assert.equal((await cli(["status"])).data.running, false)
  } finally {
    renameSync(`${fake}.unavailable`, fake)
  }
  const recovery = (await cli(["restart"])).data
  await readyAfter(null, recovery.id)
  assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), "native-auth-sentinel")
  const frames = readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.equal(
    frames.filter(
      (frame) => frame.method === "turn/start" && JSON.stringify(frame.params).includes('"hold"'),
    ).length,
    1,
    "Failed work was replayed",
  )
  const identityHome = join(workspace, "identity-race")
  mkdirSync(identityHome)
  writeFileSync(
    join(identityHome, "daemon.json"),
    JSON.stringify({ pid: process.pid, token: randomUUID() }),
  )
  const guarded = scheduleRestart(identityHome)
  writeFileSync(
    join(identityHome, "daemon.json"),
    JSON.stringify({ pid: process.pid, token: randomUUID() }),
  )
  const guardDeadline = Date.now() + 5000
  while (Date.now() < guardDeadline && isProcessAlive(guarded.workerPid!)) await Bun.sleep(30)
  const refused = new NodeMaintenanceStore(identityHome).readOperation()!
  assert.equal(refused.status, "failed")
  assert.match(refused.error!, /identity changed/)
  assert.equal(refused.newPid, null)
  assert.equal(isProcessAlive(process.pid), true)
  const ended = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  assert.equal(await ended.exited, 0)
  assert.equal(isProcessAlive(ended.pid), false)
  for (const ownership of ["missing", "stale"]) {
    const changedHome = join(workspace, `lost-owner-${ownership}`)
    mkdirSync(changedHome)
    const ownerPath = join(changedHome, "daemon.json")
    writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token: randomUUID() }), {
      mode: 0o600,
    })
    const pending = scheduleRestart(changedHome, {
      workingDirectory: workspace,
      codexHome,
    })
    const replacementLease = JSON.stringify({ pid: ended.pid, token: randomUUID() })
    if (ownership === "missing") rmSync(ownerPath)
    else writeFileSync(ownerPath, replacementLease, { mode: 0o600 })
    try {
      const deadline = performance.now() + 5000
      while (performance.now() < deadline && isProcessAlive(pending.workerPid!)) await Bun.sleep(30)
      assert.equal(
        isProcessAlive(pending.workerPid!),
        false,
        "Restart worker did not finish its ownership check",
      )
      const outcome = new NodeMaintenanceStore(changedHome).readOperation()!
      assert.equal(
        outcome.newPid,
        null,
        "Worker launched a replacement while the old PID was still alive",
      )
      assert.equal(outcome.status, "uncertain")
      assert.match(outcome.error!, /still alive/)
      assert.equal(isProcessAlive(process.pid), true)
      const unavailable = await cli(["status"], 5, changedHome)
      assert.equal(unavailable.error.details.phase, "identity")
      assert.equal(unavailable.error.details.pid, process.pid)
      assert.equal(unavailable.error.mutationMayHaveOccurred, false)
      const stopUnverified = await cli(["stop"], 5, changedHome)
      assert.equal(stopUnverified.error.details.phase, "identity")
      assert.equal(stopUnverified.error.details.executionStarted, false)
      const diagnosis = (await cli(["doctor"], 1, changedHome)).error.details
      assert.equal(diagnosis.daemon.running, null)
      assert.equal(diagnosis.daemon.pid, process.pid)
      assert.equal(diagnosis.repairable.invalidState, false)
      assert.equal(diagnosis.staleLease, false)
      assert.ok(!diagnosis.errors.some((message: string) => message.includes("Run leuco start")))
      const retried = await cli(["restart"], 5, changedHome)
      assert.equal(retried.error.details.phase, "identity")
      assert.equal(new NodeMaintenanceStore(changedHome).readOperation()!.id, pending.id)
      const repaired = await cli(["repair"], 5, changedHome)
      assert.equal(repaired.error.details.phase, "identity")
      await cli(["start"], 1, changedHome)
      assert.equal(new NodeMaintenanceStore(changedHome).readOperation()!.newPid, null)
      if (ownership === "missing") assert.equal(existsSync(ownerPath), false)
      else assert.equal(readFileSync(ownerPath, "utf8"), replacementLease)
    } finally {
      if (isProcessAlive(pending.workerPid!)) process.kill(pending.workerPid!, "SIGTERM")
      await cli(["stop"], 0, changedHome).catch(() => {})
    }
  }
  const supersededHome = join(workspace, "superseded")
  const original = scheduleRestart(supersededHome)
  const replacement = { ...original, id: randomUUID(), workerPid: null }
  const journal = new NodeMaintenanceStore(supersededHome)
  journal.writeOperation(replacement)
  const supersedeDeadline = Date.now() + 5000
  while (Date.now() < supersedeDeadline && isProcessAlive(original.workerPid!)) await Bun.sleep(30)
  assert.equal(isProcessAlive(original.workerPid!), false)
  assert.equal(journal.readOperation()!.id, replacement.id)
  assert.equal(
    journal.updateOperation(original.id, (current) => ({ ...current, status: "ready" })),
    null,
  )
  const boundedJournalHome = join(workspace, "bounded-journal")
  mkdirSync(boundedJournalHome)
  const oversized: MaintenanceOperation = {
    ...replacement,
    id: randomUUID(),
    status: "failed",
    error: `${"p".repeat(3970)}xoxb-synthetic-journal-private-token-123456789 ${"q".repeat(17 * 1024 * 1024)}`,
    causes: [{ name: "Error", message: "original failure", stack: null, code: "EBOOT" }],
  }
  assert.equal(recordMaintenanceOperation(boundedJournalHome, oversized), true)
  const boundedStatus = (await cli(["status"], 0, boundedJournalHome)).data
  assert.ok(boundedStatus.maintenance.error.length <= 4000)
  assert.ok(boundedStatus.maintenance.error.includes("[redacted]"))
  assert.ok(boundedStatus.maintenance.error.endsWith(" [truncated]"))
  assert.ok(!JSON.stringify(boundedStatus).includes("xoxb-synthetic-journal"))
  assert.equal(boundedStatus.maintenance.causes[0].code, "EBOOT")
  assert.ok(readFileSync(join(boundedJournalHome, "maintenance.json")).length < 20000)
  const boundedEvents = new LeucoEventLog({ eventLogPath: join(boundedJournalHome, "events.db") })
  try {
    const entry = boundedEvents.query({ requestId: oversized.id })[0]?.event
    assert.ok(entry?.type === "maintenance")
    assert.equal(entry.error, boundedStatus.maintenance.error)
  } finally {
    boundedEvents.close()
  }
  const limitedHome = join(workspace, "recovery-limit")
  mkdirSync(limitedHome)
  const bounded = new NodeMaintenanceStore(limitedHome)
  bounded.writeOperation({
    ...replacement,
    id: randomUUID(),
    status: "ready",
    recovery: { attempt: 3, startedAt: Date.now() },
  })
  const suppressed = (() => {
    try {
      scheduleRestart(limitedHome, {}, { automatic: true })
      return null
    } catch (error) {
      return error
    }
  })()
  assert.ok(suppressed instanceof Error && suppressed.message.includes("3 recovery attempts"))
  assert.equal(bounded.readOperation()!.status, "failed")
  assert.equal(bounded.readOperation()!.recovery!.attempt, 4)
  assert.equal(bounded.readOperation()!.workerPid, null)
  const mirrorHome = join(workspace, "maintenance-event-failure")
  mkdirSync(mirrorHome)
  writeFileSync(join(mirrorHome, "events.db"), "corrupt-maintenance-event-sentinel")
  const mirroredOperation = { ...replacement, id: randomUUID() }
  assert.equal(recordMaintenanceOperation(mirrorHome, mirroredOperation), true)
  const committed = new NodeMaintenanceStore(mirrorHome).readOperation()!
  assert.equal(committed.status, mirroredOperation.status)
  assert.ok(committed.eventLogCauses?.some((cause) => cause.code === "SQLITE_NOTADB"))
  assert.equal(
    readFileSync(join(mirrorHome, "events.db"), "utf8"),
    "corrupt-maintenance-event-sentinel",
  )
  const mirrorDiagnosis = await cli(["doctor"], 1, mirrorHome)
  assert.ok(
    mirrorDiagnosis.error.details.failures.some(
      (failure: { phase: string; causes: Array<{ code: string | null }> }) =>
        failure.phase === "maintenance-event-log" &&
        failure.causes.some((cause) => cause.code === "SQLITE_NOTADB"),
    ),
  )
  const corruptBackup = join(mirrorHome, "events.corrupt.db")
  renameSync(join(mirrorHome, "events.db"), corruptBackup)
  assert.equal(
    recordMaintenanceOperation(mirrorHome, { ...committed, updatedAt: Date.now() }, committed.id),
    true,
  )
  const recoveredMirror = new NodeMaintenanceStore(mirrorHome).readOperation()!
  assert.equal(recoveredMirror.eventLogError, null)
  assert.ok(recoveredMirror.eventLogCauses?.some((cause) => cause.code === "SQLITE_NOTADB"))
  assert.equal(readFileSync(corruptBackup, "utf8"), "corrupt-maintenance-event-sentinel")
  const recoveredDiagnosis = await cli(["doctor"], [0, 1], mirrorHome)
  const diagnosticReport = recoveredDiagnosis.ok
    ? recoveredDiagnosis.data
    : recoveredDiagnosis.error.details
  assert.ok(
    !diagnosticReport.errors.some((message: string) =>
      message.includes("Maintenance event persistence"),
    ),
  )
  assert.ok(
    !diagnosticReport.failures.some(
      (failure: { phase: string }) => failure.phase === "maintenance-event-log",
    ),
  )
  console.log(
    "Maintenance passed: detached self-restart, correlated errors, stale repair, explicit state backup/reset, bounded logs, native auth preserved, no replay",
  )
} finally {
  await cli(["stop"]).catch(() => {})
  rmSync(workspace, { recursive: true, force: true })
}
