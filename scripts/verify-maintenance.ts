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
} from "node:fs"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { scheduleRestart } from "@/maintenance/schedule-restart"
import { isProcessAlive } from "@/daemon/daemon-lease"
import { appendDaemonLog } from "@/daemon/append-daemon-log"

const repository = resolve(import.meta.dir, "..")
const workspace = realpathSync(mkdtempSync("/tmp/leuco-maint-"))
const home = join(workspace, "state")
const codexHome = join(workspace, "codex")
mkdirSync(codexHome)
writeFileSync(join(codexHome, "auth.json"), "native-auth-sentinel")
const fake = join(workspace, "fake-codex")
writeFileSync(
  fake,
  `#!/bin/sh\nexec '${process.execPath}' '${join(repository, "scripts/fixtures/fake-codex.ts")}' "$@"\n`,
  { mode: 0o700 },
)
const trace = join(workspace, "trace.jsonl")
const env = { ...process.env, LEUCO_HOME: home, CODEX_HOME: codexHome, LEUCO_VERIFY_TRACE: trace }
const executable = join(repository, "lib/index.ts")
async function cli(args: string[], code = 0) {
  const child = Bun.spawn([process.execPath, executable, ...args, "--json"], {
    cwd: workspace,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 20000)
  try {
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    assert.equal(await child.exited, code, `${args.join(" ")}\n${stdout}\n${stderr}`)
    return JSON.parse(code === 0 ? stdout : stderr)
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
  await cli(["start", "--codex-bin", fake, "--no-soul"])
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
  const restart = (await cli(["restart"])).data
  assert.equal(restart.status, "accepted")
  assert.equal(
    scheduleRestart(home).id,
    restart.id,
    "Repeated requests created a second restart worker",
  )
  const after = await readyAfter(before.pid, restart.id)
  assert.notEqual(after.runtime.instanceId, before.runtime.instanceId)
  assert.equal(after.runtime.queue.waiting, 0)
  const maintenanceEvents = (await cli(["events", "--request", restart.id])).data
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
  writeFileSync(join(home, "daemon.log"), "x".repeat(4 * 1024 * 1024))
  appendDaemonLog(home, "rotation-check")
  assert.ok(existsSync(join(home, "daemon.log.1")))
  assert.ok(readFileSync(join(home, "daemon.log"), "utf8").includes("rotation-check"))
  const restarted = (await cli(["restart"])).data
  await readyAfter(null, restarted.id)
  const failedRestart = (await cli(["restart", "--codex-bin", join(workspace, "missing-codex")]))
    .data
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
  const recovery = (await cli(["restart", "--codex-bin", fake])).data
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
  console.log(
    "Maintenance passed: detached self-restart, correlated errors, stale repair, explicit state backup/reset, bounded logs, native auth preserved, no replay",
  )
} finally {
  await cli(["stop"]).catch(() => {})
  rmSync(workspace, { recursive: true, force: true })
}
