import { repairRuntime } from "@/maintenance/repair-runtime"
import { scheduleRestart } from "@/maintenance/schedule-restart"
import { withDaemonReservation } from "@/daemon/with-daemon-reservation"
import { createDaemonStartupError } from "@/daemon/create-daemon-startup-error"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import { acquireDaemonLease, readDaemonLease, releaseDaemonLease } from "@/daemon/daemon-lease"
import { inspectDiagnosticHistory } from "@/cli/inspect-diagnostic-history"
import { readCliEvents } from "@/cli/read-cli-events"
import assert from "node:assert/strict"
import {
  symlinkSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { withFileLock } from "@/fs/with-file-lock"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { errorDetails } from "@/error-details"
import { downloadResponseToFile } from "@/fs/download-response-to-file"
import { readRegularText } from "@/fs/read-regular-text"
import { MAX_TIMER_DELAY_MS } from "@/timer-limits"
import { CliError } from "@/cli/cli-error"
import { runCli } from "@/cli/run-cli"

if (process.argv[2] === "repair-state-writer") {
  const home = process.argv[3]!
  withFileLock({ lockPath: join(home, "state.lock") }, () => {
    writeFileSync(join(home, "writer-ready"), "ready")
    const deadline = performance.now() + 3000
    const wait = new Int32Array(new SharedArrayBuffer(4))
    while (!existsSync(join(home, "daemon.json"))) {
      if (performance.now() >= deadline) throw new Error("Repair reservation was not observed")
      Atomics.wait(wait, 0, 0, 5)
    }
    atomicWriteJson({
      path: join(home, "state.json"),
      data: {
        threads: { retained: { id: "replacement-thread", context: "replacement-context" } },
        scheduleLastFiredAt: { retained: 1 },
      },
      mode: 0o600,
    })
  })
  process.exit(0)
}

if (process.argv[2] === "clock-lock-child") {
  const fixed = Date.now()
  Date.now = () => fixed
  try {
    withFileLock({ lockPath: process.argv[3]!, timeoutMs: 30 }, () => {
      throw new Error("unexpected lock acquisition")
    })
  } catch (error) {
    assert.match(String(error), /file lock busy/)
    process.stdout.write("bounded-lock-wait")
    process.exit(0)
  }
  process.exit(1)
}

if (process.argv[2] === "fifo-child") {
  try {
    withFileLock({ lockPath: process.argv[3]!, staleMs: 1, timeoutMs: 30 }, () => {})
  } catch (error) {
    process.stdout.write(JSON.stringify(errorDetails(error)))
    process.exit(1)
  }
  process.exit(0)
}

if (process.argv[2] === "download-child") {
  const mode = process.argv[3]!
  if (mode === "empty-chunks-clock") {
    const fixed = Date.now()
    Date.now = () => fixed
  }
  const emptyChunks = mode === "empty-chunks" || mode === "empty-chunks-clock"
  const directory = process.argv[4]!
  mkdirSync(directory)
  const outputPath = join(directory, "download.txt")
  writeFileSync(outputPath, "preserved")
  const controller = new AbortController()
  const abort =
    mode === "caller-abort"
      ? setTimeout(() => controller.abort(new Error("caller cancellation")), 20)
      : null
  try {
    const failure = await downloadResponseToFile({
      outputPath,
      timeoutMs: mode === "caller-abort" || emptyChunks ? 10_000 : 20,
      idleTimeoutMs: emptyChunks ? 20 : 10_000,
      signal: controller.signal,
      fetchResponse: async () => {
        if (mode === "fetch-hang" || mode === "caller-abort") return new Promise<Response>(() => {})
        const body = new ReadableStream<Uint8Array>(
          {
            pull(stream) {
              if (emptyChunks) {
                stream.enqueue(new Uint8Array())
                return
              }
              if (mode !== "cancel-hang") return
              stream.enqueue(new Uint8Array([1]))
            },
            cancel() {
              return mode === "cancel-hang" ? new Promise<void>(() => {}) : undefined
            },
          },
          { highWaterMark: 0 },
        )
        return new Response(body, { status: mode === "cancel-hang" ? 503 : 200 })
      },
    }).then(
      () => null,
      (error: unknown) => error,
    )
    assert.ok(failure instanceof Error)
    const details = errorDetails(failure)
    if (mode === "cancel-hang") {
      assert.ok(details.some((cause) => cause.message.includes("503")))
      assert.ok(details.some((cause) => /cancel.*timed out/i.test(cause.message)))
    } else
      assert.ok(
        details.some((cause) =>
          cause.message.includes(mode === "caller-abort" ? "caller cancellation" : "timed out"),
        ),
      )
    assert.equal(readFileSync(outputPath, "utf8"), "preserved")
    assert.deepEqual(readdirSync(directory), ["download.txt"])
    process.stdout.write(JSON.stringify({ mode, bounded: true }))
    process.exit(0)
  } finally {
    if (abort !== null) clearTimeout(abort)
  }
}

const workspace = mkdtempSync("/tmp/leuco-storage-cleanup-")
const failures: Error[] = []
async function check(name: string, verify: () => void | Promise<void>) {
  try {
    await verify()
  } catch (error) {
    failures.push(new Error(name, { cause: error }))
  }
}
try {
  await check("live session reset refusal preserves home permissions and saved state", () => {
    const home = join(workspace, "live-session-reset")
    mkdirSync(home)
    chmodSync(home, 0o755)
    const lease = JSON.stringify({ pid: process.pid, token: "synthetic-live-owner" })
    const state = JSON.stringify({
      threads: { keep: { id: "thread-kept", context: "context" } },
      scheduleLastFiredAt: {},
    })
    writeFileSync(join(home, "daemon.json"), lease, { mode: 0o600 })
    writeFileSync(join(home, "state.json"), state, { mode: 0o600 })
    const before = readdirSync(home).sort()
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "../lib/index.ts"), "session", "reset", "--json"],
      {
        cwd: workspace,
        env: { ...process.env, LEUCO_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
    )
    assert.equal(result.exitCode, 3)
    assert.equal(result.stdout.length, 0)
    const failure = JSON.parse(result.stderr.toString()).error
    assert.equal(failure.code, "STATE_CONFLICT")
    assert.equal(failure.mutationMayHaveOccurred, false)
    if (process.platform !== "win32") assert.equal(statSync(home).mode & 0o777, 0o755)
    assert.equal(readFileSync(join(home, "daemon.json"), "utf8"), lease)
    assert.equal(readFileSync(join(home, "state.json"), "utf8"), state)
    assert.deepEqual(readdirSync(home).sort(), before)
  })
  await check(
    "session reservation conflict reports preparation that already changed metadata",
    () => {
      const home = join(workspace, "session-reservation-race")
      mkdirSync(home)
      chmodSync(home, 0o755)
      const state = JSON.stringify({
        threads: { keep: { id: "thread-kept", context: "context" } },
        scheduleLastFiredAt: {},
      })
      writeFileSync(join(home, "state.json"), state, { mode: 0o600 })
      const lease = JSON.stringify({ pid: process.pid, token: "synthetic-racing-owner" })
      const preload = join(workspace, "publish-owner-after-preflight.ts")
      writeFileSync(
        preload,
        [
          `import { NodeLeucoStore } from ${JSON.stringify(join(import.meta.dir, "../lib/storage/node-leuco-store.ts"))}`,
          'import { writeFileSync } from "node:fs"',
          'import { join } from "node:path"',
          "const prepare = NodeLeucoStore.prototype.ensureHome",
          "NodeLeucoStore.prototype.ensureHome = function () {",
          "  prepare.call(this)",
          `  writeFileSync(join(this.home, "daemon.json"), ${JSON.stringify(lease)}, { mode: 0o600 })`,
          "}",
        ].join("\n"),
      )
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--preload",
          preload,
          join(import.meta.dir, "../lib/index.ts"),
          "session",
          "reset",
          "--json",
        ],
        {
          cwd: workspace,
          env: { ...process.env, LEUCO_HOME: home },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
        },
      )
      assert.equal(result.exitCode, 3)
      assert.equal(result.stdout.length, 0)
      const failure = JSON.parse(result.stderr.toString()).error
      assert.equal(failure.code, "STATE_CONFLICT")
      assert.equal(failure.mutationMayHaveOccurred, true)
      assert.equal(failure.details.phase, "reservation-acquire")
      assert.equal(failure.details.executionStarted, false)
      if (process.platform !== "win32") assert.equal(statSync(home).mode & 0o777, 0o700)
      assert.equal(readFileSync(join(home, "daemon.json"), "utf8"), lease)
      assert.equal(readFileSync(join(home, "state.json"), "utf8"), state)
    },
  )
  await check("pre-cancelled CLI and repair leave local state untouched", async () => {
    const previousHome = process.env.LEUCO_HOME
    const reason = new Error("verification caller cancelled")
    const signal = AbortSignal.abort(reason)
    try {
      const commands = [
        ["config", "set", "model", '"cancelled-model"'],
        ["session", "reset"],
      ]
      for (const index of commands.keys()) {
        const args = commands[index]!
        const home = join(workspace, `cancelled-cli-${index}`)
        process.env.LEUCO_HOME = home
        await assert.rejects(runCli(args, { signal }), (error) => error === reason)
        assert.equal(existsSync(home), false)
      }
    } finally {
      if (previousHome === undefined) delete process.env.LEUCO_HOME
      else process.env.LEUCO_HOME = previousHome
    }
    const home = join(workspace, "cancelled-repair")
    mkdirSync(home)
    const state = Buffer.from("damaged-state-sentinel")
    writeFileSync(join(home, "state.json"), state)
    await assert.rejects(
      repairRuntime(home, { resetState: true, signal }),
      (error) => error === reason,
    )
    assert.deepEqual(readFileSync(join(home, "state.json")), state)
    assert.deepEqual(readdirSync(home), ["state.json"])
  })
  await check("old cleanup preserves changed owner metadata and its control path", () => {
    const changedHome = join(workspace, "changed-owner")
    mkdirSync(changedHome)
    const previous = acquireDaemonLease(changedHome)
    const changed = { ...previous, pid: previous.pid + 1 }
    atomicWriteJson({ path: join(changedHome, "daemon.json"), data: changed, mode: 0o600 })
    writeFileSync(join(changedHome, "control.sock"), "changed-owner-control-sentinel", {
      mode: 0o600,
    })
    assert.equal(releaseDaemonLease(changedHome, previous), false)
    assert.deepEqual(readDaemonLease(changedHome), changed)
    assert.equal(
      readFileSync(join(changedHome, "control.sock"), "utf8"),
      "changed-owner-control-sentinel",
    )
    atomicWriteJson({ path: join(changedHome, "daemon.json"), data: previous, mode: 0o600 })
    assert.equal(releaseDaemonLease(changedHome, previous), true)
    assert.equal(readDaemonLease(changedHome), null)
    assert.equal(existsSync(join(changedHome, "control.sock")), false)
  })
  await check(
    "completed reservation work remains unconfirmed after owner replacement",
    async () => {
      const reservedHome = join(workspace, "reservation-owner-change")
      mkdirSync(reservedHome)
      const failure = await withDaemonReservation(reservedHome, () => {
        writeFileSync(join(reservedHome, "completed-operation"), "retained-effect", { mode: 0o600 })
        const owner = readDaemonLease(reservedHome)
        assert.ok(owner)
        atomicWriteJson({
          path: join(reservedHome, "daemon.json"),
          data: { ...owner, pid: owner.pid + 1 },
          mode: 0o600,
        })
        writeFileSync(join(reservedHome, "control.sock"), "new-owner-control", { mode: 0o600 })
        return "completed"
      }).catch((error: unknown) => error)
      assert.ok(
        typeof failure === "object" &&
          failure !== null &&
          "code" in failure &&
          failure.code === "STATE_UNCERTAIN",
      )
      assert.ok(
        "details" in failure &&
          typeof failure.details === "object" &&
          failure.details !== null &&
          "operationCompleted" in failure.details &&
          failure.details.operationCompleted === true,
      )
      assert.equal(readDaemonLease(reservedHome)?.pid, process.pid + 1)
      assert.equal(readFileSync(join(reservedHome, "control.sock"), "utf8"), "new-owner-control")
      assert.equal(
        readFileSync(join(reservedHome, "completed-operation"), "utf8"),
        "retained-effect",
      )
    },
  )
  await check("stale restart ownership is rejected before any operation is saved", () => {
    const restartHome = join(workspace, "restart-owner-change")
    mkdirSync(restartHome)
    const previous = acquireDaemonLease(restartHome)
    const changed = { ...previous, pid: previous.pid + 1 }
    atomicWriteJson({ path: join(restartHome, "daemon.json"), data: changed, mode: 0o600 })
    new NodeMaintenanceStore(restartHome).writeLaunch({
      workingDirectory: workspace,
      codexHome: null,
    })
    const failure = (() => {
      try {
        return scheduleRestart(restartHome, {}, { expectedLease: previous, automatic: true })
      } catch (error) {
        return error
      }
    })()
    assert.ok(
      typeof failure === "object" &&
        failure !== null &&
        "code" in failure &&
        failure.code === "STATE_CONFLICT",
    )
    assert.equal(existsSync(join(restartHome, "maintenance.json")), false)
    assert.deepEqual(readDaemonLease(restartHome), changed)
  })
  await check(
    "state reset preserves a concurrent valid replacement under the state lock",
    async () => {
      const home = join(workspace, "reset-concurrent-state")
      mkdirSync(home)
      writeFileSync(join(home, "state.json"), "invalid state")
      const writer = Bun.spawn([process.execPath, import.meta.path, "repair-state-writer", home], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      })
      const timer = setTimeout(() => writer.kill("SIGKILL"), 5000)
      try {
        const deadline = performance.now() + 3000
        while (!existsSync(join(home, "writer-ready"))) {
          assert.ok(performance.now() < deadline, "State writer did not acquire the lock")
          await Bun.sleep(5)
        }
        await assert.rejects(
          repairRuntime(home, { resetState: true }),
          (error) =>
            error instanceof CliError &&
            error.code === "STATE_CONFLICT" &&
            JSON.stringify(error.details).includes("state-reset"),
        )
        assert.equal(await writer.exited, 0)
        assert.deepEqual(new NodeLeucoStore(home).loadState(), {
          threads: { retained: { id: "replacement-thread", context: "replacement-context" } },
          scheduleLastFiredAt: { retained: 1 },
        })
        assert.equal(
          readdirSync(home).some((name) => name.startsWith("state.invalid.")),
          false,
        )
        assert.equal(readDaemonLease(home), null)
      } finally {
        clearTimeout(timer)
        if (writer.exitCode === null) writer.kill("SIGKILL")
        await writer.exited
      }
    },
  )
  await check("state reset consumes stale ownership only once", async () => {
    const resetHome = join(workspace, "reset-with-stale-owner")
    mkdirSync(resetHome)
    const exited = Bun.spawn([process.execPath, "-e", ""], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    const timer = setTimeout(() => exited.kill("SIGKILL"), 3000)
    try {
      assert.equal(await exited.exited, 0)
    } finally {
      clearTimeout(timer)
      if (exited.exitCode === null) exited.kill("SIGKILL")
      await exited.exited
    }
    atomicWriteJson({
      path: join(resetHome, "daemon.json"),
      data: { pid: exited.pid, token: "stale-reset-owner" },
      mode: 0o600,
    })
    const invalidState = Buffer.from([0x7b, 0x22, 0x80, 0xff, 0xf0, 0x9f])
    writeFileSync(join(resetHome, "state.json"), invalidState, { mode: 0o600 })
    const repaired = await repairRuntime(resetHome, { resetState: true })
    assert.equal(repaired.repaired, true)
    assert.equal(repaired.restart, null)
    assert.equal(readDaemonLease(resetHome), null)
    assert.deepEqual(JSON.parse(readFileSync(join(resetHome, "state.json"), "utf8")), {
      threads: {},
      scheduleLastFiredAt: {},
    })
    assert.equal(
      readdirSync(resetHome).filter((name) => name.startsWith("state.invalid.")).length,
      1,
    )
    const backupName = readdirSync(resetHome).find((name) => name.startsWith("state.invalid."))
    assert.ok(backupName)
    assert.deepEqual(readFileSync(join(resetHome, backupName)), invalidState)
    assert.equal(statSync(join(resetHome, backupName)).mode & 0o777, 0o600)
  })
  await check("failed IPC preparation does not publish a live daemon owner", async () => {
    const failedHome = join(workspace, "failed-ipc-preparation")
    mkdirSync(join(failedHome, "control.sock"), { recursive: true })
    assert.throws(
      () => acquireDaemonLease(failedHome),
      (error) =>
        errorDetails(error).some((cause) =>
          ["EISDIR", "ERR_FS_EISDIR", "EACCES", "EPERM"].includes(cause.code ?? ""),
        ),
    )
    assert.equal(readDaemonLease(failedHome), null)
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "lib", "index.ts"), "status", "--json"],
      {
        env: { ...process.env, LEUCO_HOME: failedHome },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
    try {
      const stdout = await new Response(child.stdout).text()
      const stderr = await new Response(child.stderr).text()
      assert.equal(await child.exited, 0, stderr)
      assert.equal(JSON.parse(stdout).data.running, false)
      assert.ok(statSync(join(failedHome, "control.sock")).isDirectory())
      assert.deepEqual(readdirSync(failedHome), ["control.sock"])
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  })
  await check("startup diagnostics refuse a replaced log without hiding the child failure", () => {
    const diagnosticHome = join(workspace, "startup-log-link")
    mkdirSync(diagnosticHome)
    const privatePath = join(workspace, "startup-private-target")
    writeFileSync(privatePath, "private-startup-target-sentinel")
    symlinkSync(privatePath, join(diagnosticHome, "daemon.log"))
    const failure = createDaemonStartupError({
      home: diagnosticHome,
      pid: 42,
      exitCode: 1,
      signal: null,
      spawnError: Object.assign(new Error("child failed"), { code: "EPIPE" }),
    })
    const diagnostic = JSON.stringify(failure.details)
    assert.ok(!diagnostic.includes("private-startup-target-sentinel"))
    assert.ok(diagnostic.includes('"exitCode":1'))
    assert.ok(diagnostic.includes("EPIPE"))
    assert.ok(diagnostic.includes("Refusing to read a symbolic link"))
    assert.equal(readFileSync(privatePath, "utf8"), "private-startup-target-sentinel")
  })
  await check("broken local-data links remain visible failures", async () => {
    const damagedHome = join(workspace, "broken-local-data")
    mkdirSync(damagedHome)
    for (const name of [
      "settings.json",
      "state.json",
      "launch.json",
      "maintenance.json",
      "events.db",
      "daemon.json",
    ])
      symlinkSync(join(damagedHome, `missing-${name}`), join(damagedHome, name))
    const store = new NodeLeucoStore(damagedHome)
    const maintenance = new NodeMaintenanceStore(damagedHome)
    assert.throws(() => store.loadSettings())
    assert.throws(() => store.loadState())
    assert.throws(() => maintenance.readLaunch())
    assert.throws(() => maintenance.readOperation())
    assert.throws(() => readDaemonLease(damagedHome))
    const history = inspectDiagnosticHistory(damagedHome)
    assert.equal(history.eventLogValid, false)
    assert.ok(
      history.failures.some((failure) => failure.causes.some((cause) => cause.code === "ENOENT")),
    )
    await assert.rejects(
      readCliEvents({ home: damagedHome, limit: 10, requestId: "broken-link", filters: {} }),
    )
    chmodSync(damagedHome, 0)
    try {
      for (const read of [
        () => store.loadSettings(),
        () => store.loadState(),
        () => maintenance.readLaunch(),
        () => maintenance.readOperation(),
        () => readDaemonLease(damagedHome),
      ])
        assert.throws(read, (error) => errorDetails(error).some((cause) => cause.code === "EACCES"))
      const denied = inspectDiagnosticHistory(damagedHome)
      assert.equal(denied.eventLogValid, false)
      assert.ok(
        denied.failures.some((failure) => failure.causes.some((cause) => cause.code === "EACCES")),
      )
      await assert.rejects(
        readCliEvents({ home: damagedHome, limit: 10, requestId: "denied-history", filters: {} }),
        (error) => errorDetails(error).some((cause) => cause.code === "EACCES"),
      )
    } finally {
      chmodSync(damagedHome, 0o700)
    }
    const absentHome = join(workspace, "absent-local-data")
    assert.deepEqual(new NodeLeucoStore(absentHome).loadState(), {
      threads: {},
      scheduleLastFiredAt: {},
    })
    assert.equal(new NodeMaintenanceStore(absentHome).readLaunch(), null)
    assert.equal(readDaemonLease(absentHome), null)
    assert.equal(inspectDiagnosticHistory(absentHome).eventLogValid, true)
    assert.deepEqual(
      await readCliEvents({
        home: absentHome,
        limit: 10,
        requestId: "absent-history",
        filters: {},
      }),
      [],
    )
  })
  await check("lock wait is bounded independently of wall-clock progression", async () => {
    const path = join(workspace, "clock.lock")
    writeFileSync(path, JSON.stringify({ pid: process.pid, token: "busy-lock-sentinel" }))
    const child = Bun.spawn([process.execPath, import.meta.path, "clock-lock-child", path], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
    try {
      const output = new Response(child.stdout).text()
      const errors = new Response(child.stderr).text()
      assert.equal(await child.exited, 0, await errors)
      assert.equal(await output, "bounded-lock-wait")
      assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "busy-lock-sentinel")
    } finally {
      clearTimeout(timer)
    }
  })
  await check("bounded UTF-8 text reading", () => {
    const path = join(workspace, "bounded-text.txt")
    const text = `\ufeff${"あ😀".repeat(20000)}`
    writeFileSync(path, text)
    const bytes = new TextEncoder().encode(text).length
    assert.equal(readRegularText(path, bytes), text)
    assert.throws(() => readRegularText(path, bytes - 1), /byte read limit/)
    const empty = join(workspace, "empty-text.txt")
    writeFileSync(empty, "")
    assert.equal(readRegularText(empty, 0), "")
  })
  await check("SOUL preserves valid UTF-8 and rejects malformed instruction bytes", () => {
    const store = new NodeLeucoStore(join(workspace, "instruction-home"))
    const path = join(workspace, "instruction-soul.md")
    const text = "\ufeff指示をそのまま読む😀\n"
    writeFileSync(path, text)
    assert.equal(store.readInstructions(path), text)
    for (const bytes of [
      [0xe3, 0x81],
      [0xed, 0xa0, 0x80],
      [0xc0, 0xaf],
    ]) {
      writeFileSync(path, Uint8Array.from(bytes))
      assert.throws(() => store.readInstructions(path), /SOUL file is not valid UTF-8/)
    }
  })
  for (const primaryFails of [false, true]) {
    await check(`lock release failure; primary failure=${primaryFails}`, () => {
      const directory = join(workspace, String(primaryFails))
      mkdirSync(directory)
      const lockPath = join(directory, "settings.lock")
      const primary = new Error("primary-operation-failure")
      const observation: { error: unknown } = { error: null }
      try {
        withFileLock({ lockPath }, () => {
          writeFileSync(join(directory, "committed.json"), '{"committed":true}')
          chmodSync(directory, 0o500)
          if (primaryFails) throw primary
          return "completed"
        })
      } catch (error) {
        observation.error = error
      } finally {
        chmodSync(directory, 0o700)
      }
      assert.ok(observation.error instanceof Error, "Lock release failure was reported as success")
      assert.equal(existsSync(lockPath), true)
      assert.ok(
        errorDetails(observation.error).some(
          (cause) => cause.code === "EACCES" || cause.code === "EPERM",
        ),
      )
      if (primaryFails) {
        assert.ok(observation.error instanceof AggregateError)
        assert.equal(observation.error.errors[0], primary)
      }
      rmSync(lockPath)
    })
  }
  await check("unrepresentable JSON must not replace existing state", () => {
    const path = join(workspace, "settings.json")
    writeFileSync(path, '{"preserved":true}\n')
    assert.throws(() => atomicWriteJson({ path, data: undefined, mode: 0o600 }))
    assert.equal(readFileSync(path, "utf8"), '{"preserved":true}\n')
  })
  await check("JSON writes must not exceed the default read budget", () => {
    const maximum = 16 * 1024 * 1024
    const directory = join(workspace, "json-byte-limit")
    mkdirSync(directory)
    const path = join(directory, "state.json")
    writeFileSync(path, '{"preserved":true}\n')
    const oversized = "あ".repeat(Math.ceil(maximum / 3))
    assert.ok(oversized.length < maximum)
    assert.throws(() => atomicWriteJson({ path, data: oversized }), /byte.*limit/)
    assert.equal(readRegularText(path), '{"preserved":true}\n')
    const absent = join(directory, "must-not-create", "state.json")
    assert.throws(() => atomicWriteJson({ path: absent, data: oversized }), /byte.*limit/)
    assert.equal(existsSync(join(directory, "must-not-create")), false)
    const exact = "a".repeat(maximum - 3)
    atomicWriteJson({ path, data: exact })
    assert.equal(statSync(path).size, maximum)
    assert.equal(JSON.parse(readRegularText(path)), exact)
    assert.throws(() => atomicWriteJson({ path, data: `${exact}a` }), /byte.*limit/)
    assert.equal(JSON.parse(readRegularText(path)), exact)
    assert.deepEqual(readdirSync(directory), ["state.json"])
  })
  await check("oversized settings and state remain readable after a rejected update", () => {
    const directory = join(workspace, "store-byte-limit")
    const store = new NodeLeucoStore(directory)
    store.updateSettings((settings) => ({ ...settings, model: "preserved-model" }))
    store.updateState((state) => ({
      ...state,
      threads: { keep: { id: "preserved-thread", context: "preserved-context" } },
    }))
    const settings = store.loadSettings()
    const state = store.loadState()
    const oversized = "あ".repeat(Math.ceil((16 * 1024 * 1024) / 3))
    assert.throws(
      () => store.updateSettings((current) => ({ ...current, model: oversized })),
      /byte.*limit/,
    )
    assert.throws(
      () =>
        store.updateState((current) => ({
          ...current,
          threads: { ...current.threads, large: { id: "large-thread", context: oversized } },
        })),
      /byte.*limit/,
    )
    assert.deepEqual(store.loadSettings(), settings)
    assert.deepEqual(store.loadState(), state)
    assert.deepEqual(readdirSync(directory).sort(), ["settings.json", "state.json"])
  })
  await check("malformed FIFO lock must not hang", async () => {
    const lockPath = join(workspace, "fifo.lock")
    const fifo = Bun.spawnSync(["mkfifo", lockPath], {
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 65536,
    })
    assert.equal(fifo.exitCode, 0)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old)
    const child = Bun.spawn([process.execPath, import.meta.path, "fifo-child", lockPath], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
    try {
      assert.equal(await child.exited, 1, "FIFO inspection hung or incorrectly acquired the lock")
      assert.match((await output)[0]!, /regular file/)
      assert.equal(existsSync(lockPath), true)
    } finally {
      clearTimeout(timer)
    }
  })
  await Promise.all(
    [
      "fetch-hang",
      "read-hang",
      "cancel-hang",
      "caller-abort",
      "empty-chunks",
      "empty-chunks-clock",
    ].map((mode) =>
      check(`bounded download ${mode}`, async () => {
        const child = Bun.spawn(
          [process.execPath, import.meta.path, "download-child", mode, join(workspace, mode)],
          { stdout: "pipe", stderr: "pipe" },
        )
        const output = Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        const timer = setTimeout(() => child.kill("SIGKILL"), 4000)
        try {
          assert.equal(
            await child.exited,
            0,
            `Download did not finish within its bounded cleanup window: ${mode}\n${(await output).join("\n")}`,
          )
        } finally {
          clearTimeout(timer)
        }
      }),
    ),
  )
  await check("failed download reports temporary-file cleanup failure", async () => {
    const directory = join(workspace, "download-cleanup-failure")
    mkdirSync(directory)
    const outputPath = join(directory, "download.txt")
    writeFileSync(outputPath, "preserved")
    const primary = new Error("stream failed during download")
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          chmodSync(directory, 0o500)
          controller.error(primary)
        },
      },
      { highWaterMark: 0 },
    )
    const failure = await downloadResponseToFile({
      outputPath,
      fetchResponse: async () => new Response(body),
    }).then(
      () => null,
      (error: unknown) => error,
    )
    chmodSync(directory, 0o700)
    assert.ok(failure instanceof AggregateError)
    const causes = errorDetails(failure)
    assert.ok(causes.some((cause) => cause.message.includes("stream failed during download")))
    assert.ok(causes.some((cause) => cause.code === "EACCES" || cause.code === "EPERM"))
    assert.equal(readFileSync(outputPath, "utf8"), "preserved")
  })
  for (const name of ["timeoutMs", "idleTimeoutMs"]) {
    for (const value of [MAX_TIMER_DELAY_MS + 1, Number.MAX_SAFE_INTEGER]) {
      await check(`reject overflowing download ${name} ${value} before fetching`, async () => {
        const directory = join(workspace, `overflow-${name}-${value}`)
        mkdirSync(directory)
        const outputPath = join(directory, "download.txt")
        writeFileSync(outputPath, "preserved")
        const calls = { fetch: 0 }
        const failure = await downloadResponseToFile({
          outputPath,
          [name]: value,
          fetchResponse: async () => {
            calls.fetch += 1
            return new Response("unexpected replacement")
          },
        }).catch((error: unknown) => error)
        assert.ok(failure instanceof Error)
        assert.ok(failure.message.includes(`download ${name}`))
        assert.ok(failure.message.includes(String(MAX_TIMER_DELAY_MS)))
        assert.equal(calls.fetch, 0)
        assert.equal(readFileSync(outputPath, "utf8"), "preserved")
        assert.deepEqual(readdirSync(directory), ["download.txt"])
      })
    }
  }
  for (const mode of ["consumed-body", "non-byte-chunk"]) {
    await check(`invalid download ${mode} must not replace a file`, async () => {
      const directory = join(workspace, mode)
      mkdirSync(directory)
      const outputPath = join(directory, "download.txt")
      writeFileSync(outputPath, "preserved")
      const response =
        mode === "consumed-body"
          ? new Response("already read")
          : new Response(
              new ReadableStream<string>({
                start(stream) {
                  stream.enqueue("not bytes")
                  stream.close()
                },
              }),
            )
      if (mode === "consumed-body") await response.text()
      const failure = await downloadResponseToFile({
        outputPath,
        fetchResponse: async () => response,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(failure instanceof Error, "Invalid stream was reported as a successful download")
      assert.equal(readFileSync(outputPath, "utf8"), "preserved")
      assert.deepEqual(readdirSync(directory), ["download.txt"])
    })
  }
  await check("valid download permits empty chunks and preserves private UTF-8 bytes", async () => {
    const directory = join(workspace, "valid-download")
    mkdirSync(directory)
    const outputPath = join(directory, "download.txt")
    const text = "応答を保存する"
    const chunks = [new Uint8Array(), new TextEncoder().encode(text)]
    const body = new ReadableStream<Uint8Array>(
      {
        pull(stream) {
          const chunk = chunks.shift()
          if (chunk === undefined) stream.close()
          else stream.enqueue(chunk)
        },
      },
      { highWaterMark: 0 },
    )
    assert.deepEqual(
      await downloadResponseToFile({
        outputPath,
        fetchResponse: async () => new Response(body),
        timeoutMs: MAX_TIMER_DELAY_MS,
        idleTimeoutMs: MAX_TIMER_DELAY_MS,
        maxBytes: Number.MAX_SAFE_INTEGER,
      }),
      { outputPath, size: Buffer.byteLength(text) },
    )
    assert.equal(readFileSync(outputPath, "utf8"), text)
    assert.equal(statSync(outputPath).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(directory), ["download.txt"])
  })
  if (failures.length) throw new AggregateError(failures, "Storage cleanup verification failed")
  console.log(
    "Storage cleanup passed: visible unlock failures, preserved causes, bounded FIFO/download waits, preserved download destinations and private UTF-8 bytes",
  )
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
