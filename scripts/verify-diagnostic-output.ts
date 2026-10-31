import assert from "node:assert/strict"
import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeDiagnosticOutput } from "@/node-diagnostic-output"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { errorDetails } from "@/error-details"
import pkg from "../package.json" with { type: "json" }
import { getCliSpecification } from "@/cli/get-cli-specification"
import { DaemonTextLog } from "@/daemon/daemon-text-log"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { recordMaintenanceOperation } from "@/maintenance/record-maintenance-operation"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import { randomUUID } from "node:crypto"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { MemoryDiagnosticOutput } from "@/memory-diagnostic-output"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { LeucoCodexClient } from "@/engine/codex/codex-client"
import { redactPublicText } from "@/secrets/redact-public-text"

const mode = process.argv[2]
if (
  [
    "codex-log-consumer",
    "codex-notification-consumer",
    "codex-log-consumer-closed",
    "codex-notification-consumer-closed",
    "codex-notification-with-log",
  ].includes(mode ?? "")
) {
  const workspace = mkdtempSync(join(tmpdir(), "leuco-codex-consumer-"))
  const secret = "synthetic-consumer-private-credential"
  const initial = "diagnostic\n\u001b[2J"
  const prefix = mode?.startsWith("codex-log-consumer")
    ? 0
    : "[codex notification consumer failed] ".length
  const failure = new Error(`${initial}${"p".repeat(3988 - initial.length - prefix)}${secret}tail`)
  const received: Array<{ line: string; level: string | undefined }> = []
  const client = new LeucoCodexClient({
    bin: process.execPath,
    args: [join(import.meta.dir, "fixtures", "fake-codex.ts")],
    env: {
      ...process.env,
      LEUCO_VERIFY_TURN_STDERR: "1",
      LEUCO_VERIFY_TRACE: join(workspace, "trace.jsonl"),
    },
    ...(mode?.startsWith("codex-log-consumer")
      ? {
          onLog: () => {
            throw failure
          },
        }
      : {
          onAnyNotification: () => {
            throw failure
          },
        }),
    ...(mode === "codex-notification-with-log"
      ? {
          onLog: (line: string, level?: string) => {
            received.push({ line, level })
          },
        }
      : {}),
    redactLogText: (text) => redactPublicText(text, [secret]),
  })
  try {
    await client.start()
    assert.equal(await client.runTextTurn("thread-diagnostic", "probe"), "verified reply")
  } finally {
    await client.stop()
    rmSync(workspace, { recursive: true, force: true })
  }
  if (mode === "codex-notification-with-log") {
    const errors = received.filter((entry) =>
      entry.line.startsWith("[codex notification consumer failed]"),
    )
    assert.ok(errors.length > 0)
    assert.ok(
      errors.every((entry) => entry.level === "error"),
      "Notification callback failures must remain visible as errors",
    )
    assert.ok(!JSON.stringify(errors).includes("synthetic-"))
    console.log(JSON.stringify({ survived: true, errorsVisible: true }))
  } else if (mode?.endsWith("-closed")) {
    const health = client.getStatus().diagnostics
    assert.equal(health.healthy, false)
    assert.equal(health.pending, 0)
    assert.ok(health.lastFailure?.causes.some((cause) => cause.code === "EPIPE"))
    console.log(JSON.stringify({ survived: true, diagnosticRecorded: true }))
  } else console.log(JSON.stringify({ survived: true }))
} else if (mode === "backpressure") {
  const output = new NodeDiagnosticOutput()
  await assert.rejects(
    awaitBoundedCleanup(output.write("x".repeat(16000)), "Diagnostic probe", 30),
    /timed out/,
  )
  await assert.rejects(output.write("must not queue another write"), (error) =>
    errorDetails(error).some((cause) => cause.code === "EBUSY"),
  )
  console.log(JSON.stringify({ timedOut: true, busy: true }))
} else if (["runtime-log-stderr-closed", "runtime-log-async"].includes(mode ?? "")) {
  const events = new LeucoEventLog({ diagnosticOutput: new MemoryDiagnosticOutput() })
  const runtime = LeucoRuntime.build({
    store: new MemoryLeucoStore(),
    codex: new MemoryCodexClient(),
    eventLog: events,
    env: {},
    onLog: () => {
      if (mode === "runtime-log-async") return Promise.reject(new Error("host consumer failed"))
      throw new Error("host consumer failed")
    },
    connections: [
      {
        name: "probe",
        getIdentity: () => ({ name: "probe", type: "schedule", botUserId: null }),
        start: async (context) => context.onLog("probe record"),
        stop: async () => {},
      },
    ],
  })
  try {
    await runtime.start()
    await Bun.sleep(50)
    await runtime.stop()
    assert.ok(
      events
        .query()
        .some(
          (entry) =>
            entry.event.type === "log" && entry.event.line.includes("host consumer failed"),
        ),
    )
    console.log(JSON.stringify({ survived: true, diagnosticRecorded: true }))
  } finally {
    await runtime.stop()
    events.close()
  }
} else if (mode === "maintenance-stderr-closed") {
  const home = process.argv[3]!
  const operation: MaintenanceOperation = {
    id: randomUUID(),
    status: "accepted",
    requestedAt: Date.now(),
    updatedAt: Date.now(),
    workerPid: null,
    oldPid: null,
    oldLeaseId: null,
    recovery: null,
    newPid: null,
    error: null,
    launch: { workingDirectory: process.cwd(), codexHome: null },
  }
  assert.equal(recordMaintenanceOperation(home, operation), true)
  await Bun.sleep(50)
  assert.ok(
    new NodeMaintenanceStore(home)
      .readOperation()
      ?.eventLogCauses?.some((cause) => cause.code === "SQLITE_NOTADB"),
  )
  console.log(JSON.stringify({ survived: true, journal: true }))
} else if (mode === "text-log-stderr-closed") {
  const log = new DaemonTextLog({ home: process.argv[3]! })
  assert.ok(log.write("failure probe") instanceof Error)
  const until = performance.now() + 2000
  while (log.getHealth().lastReportError === null && performance.now() < until) await Bun.sleep(10)
  assert.ok(log.getHealth().lastReportError?.causes.some((cause) => cause.code === "EPIPE"))
  assert.ok(log.getHealth().lastReportError?.causes.some((cause) => cause.code === "EISDIR"))
  console.log(JSON.stringify({ survived: true, failed: !log.getHealth().healthy }))
} else if (mode === "event-log-stderr-closed") {
  const log = new LeucoEventLog({ eventLogPath: process.argv[3] })
  try {
    const until = performance.now() + 2000
    while (
      !log.getHealth().lastPersistError?.causes.some((cause) => cause.code === "EPIPE") &&
      performance.now() < until
    )
      await Bun.sleep(10)
    assert.ok(
      log.getHealth().lastPersistError?.causes.some((cause) => cause.code === "SQLITE_NOTADB"),
    )
    assert.ok(log.getHealth().lastPersistError?.causes.some((cause) => cause.code === "EPIPE"))
    console.log(JSON.stringify({ survived: true, persistenceAndReportingCauses: true }))
  } finally {
    log.close()
  }
} else if (mode === "append") {
  const output = new NodeDiagnosticOutput()
  await output.write("first 😀\n")
  await output.write("second\n")
  await Bun.write(Bun.stderr, "caller still writable\n")
  console.log(JSON.stringify({ appended: true }))
} else {
  const workspace = mkdtempSync(join(tmpdir(), "leuco-diagnostic-output-"))
  const outputDelivery = getCliSpecification().outputDelivery
  const executable = join(import.meta.dir, "..", "lib", "index.ts")
  const run = async (scenario: string, descriptor: number) => {
    const isCli = scenario.startsWith("cli-")
    const child = Bun.spawn(
      isCli
        ? [
            process.execPath,
            executable,
            ...(scenario === "cli-mutation"
              ? ["config", "set", "model", '"output-probe"']
              : [scenario === "cli-stderr-closed" ? "unknown-command" : "--version"]),
            "--json",
          ]
        : [
            process.execPath,
            import.meta.path,
            scenario,
            ...(scenario === "event-log-stderr-closed"
              ? [join(workspace, "corrupt-events.db")]
              : scenario === "text-log-stderr-closed"
                ? [join(workspace, "text-log-failure")]
                : scenario === "maintenance-stderr-closed"
                  ? [join(workspace, "maintenance-failure")]
                  : []),
          ],
      {
        stdin: "ignore",
        stdout: ["cli-output", "cli-mutation"].includes(scenario) ? descriptor : "pipe",
        stderr:
          isCli ||
          [
            "event-log-stderr-closed",
            "text-log-stderr-closed",
            "runtime-log-stderr-closed",
            "runtime-log-async",
            "maintenance-stderr-closed",
            "codex-log-consumer-closed",
            "codex-notification-consumer-closed",
          ].includes(scenario)
            ? "pipe"
            : descriptor,
        env: {
          ...process.env,
          LEUCO_HOME: join(workspace, scenario === "cli-mutation" ? "cli-mutation" : "cli-home"),
        },
      },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), isCli ? 7000 : 3000)
    try {
      if (scenario === "cli-stdout-closed" && child.stdout instanceof ReadableStream)
        await child.stdout.cancel()
      if (
        [
          "cli-stderr-closed",
          "event-log-stderr-closed",
          "text-log-stderr-closed",
          "runtime-log-stderr-closed",
          "runtime-log-async",
          "maintenance-stderr-closed",
          "codex-log-consumer-closed",
          "codex-notification-consumer-closed",
        ].includes(scenario) &&
        child.stderr instanceof ReadableStream
      )
        await child.stderr.cancel()
      const stream = isCli && scenario !== "cli-stderr-closed" ? child.stderr : child.stdout
      assert.ok(stream instanceof ReadableStream)
      const text = await new Response(stream).text()
      assert.equal(
        await child.exited,
        isCli ? outputDelivery.unconfirmed.exitCode : outputDelivery.successRequiresExitCode,
        `${scenario}: ${text}`,
      )
      if (scenario === "cli-stderr-closed") {
        assert.equal(text, "")
        return { exitCode: 5 }
      }
      return JSON.parse(text)
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  }
  try {
    const stopped: { promise: Promise<void> | null } = { promise: null }
    const client = new LeucoCodexClient({
      bin: process.execPath,
      args: [join(import.meta.dir, "fixtures", "fake-codex.ts")],
      env: { ...process.env, LEUCO_VERIFY_TRACE: join(workspace, "cancelled-start.jsonl") },
      onLog: (line) => {
        if (line.startsWith("[codex] app-server ready")) stopped.promise = client.stop()
      },
    })
    try {
      const startupFailure = await client.start().then(
        () => null,
        (error: unknown) => error,
      )
      await stopped.promise
      assert.ok(stopped.promise !== null)
      assert.ok(startupFailure instanceof Error, "A stopped Codex startup returned success")
      assert.equal(client.isRunning(), false)
      assert.equal(client.getStatus().pid, null)
    } finally {
      await client.stop()
    }
    const correlationBarrier = join(workspace, "turn-acknowledged")
    const notifications = new Map<string, string | undefined>()
    const correlated = new LeucoCodexClient({
      bin: process.execPath,
      args: [join(import.meta.dir, "fixtures", "fake-codex.ts")],
      env: {
        ...process.env,
        LEUCO_VERIFY_TRACE: join(workspace, "correlated-notifications.jsonl"),
        LEUCO_VERIFY_NOTIFICATION_CORRELATION_FILE: correlationBarrier,
      },
      onAnyNotification: (method, _params, requestId) => {
        notifications.set(method, requestId)
      },
    })
    try {
      await correlated.start()
      assert.equal(
        await correlated.runTextTurn("thread-correlation", "probe", {
          requestId: "correlated-request",
          onActivity: (method) => {
            if (method === "turn/start") writeFileSync(correlationBarrier, "acknowledged")
          },
        }),
        "verified reply",
      )
      assert.equal(notifications.get("probe/current"), "correlated-request")
      assert.equal(notifications.get("turn/completed"), "correlated-request")
      for (const method of [
        "probe/unconfirmed",
        "probe/conflicting",
        "probe/old-turn",
        "probe/other-thread",
        "probe/background",
      ]) {
        assert.ok(notifications.has(method), `Notification was discarded: ${method}`)
        assert.equal(notifications.get(method), undefined, `Unverified attribution: ${method}`)
      }
    } finally {
      await correlated.stop()
    }
    for (const scenario of ["codex-log-consumer", "codex-notification-consumer"]) {
      const path = join(workspace, `${scenario}.log`)
      const descriptor = openSync(path, "w", 0o600)
      try {
        assert.deepEqual(await run(scenario, descriptor), { survived: true })
      } finally {
        closeSync(descriptor)
      }
      const diagnostic = readFileSync(path, "utf8")
      assert.ok(diagnostic.includes("consumer failed"))
      assert.ok(
        !diagnostic.includes("synthetic-"),
        "A clipped diagnostic retained a secret fragment",
      )
      assert.ok(!diagnostic.includes("\u001b"), "Diagnostic output retained terminal controls")
      assert.ok(
        diagnostic
          .split("\n")
          .filter(Boolean)
          .every((line) => line.startsWith("[codex ")),
      )
      assert.ok(diagnostic.isWellFormed())
    }
    assert.deepEqual(await run("codex-notification-with-log", 2), {
      survived: true,
      errorsVisible: true,
    })
    for (const scenario of ["codex-log-consumer-closed", "codex-notification-consumer-closed"])
      assert.deepEqual(await run(scenario, 2), { survived: true, diagnosticRecorded: true })
    assert.deepEqual(await run("runtime-log-stderr-closed", 2), {
      survived: true,
      diagnosticRecorded: true,
    })
    assert.deepEqual(await run("runtime-log-async", 2), {
      survived: true,
      diagnosticRecorded: true,
    })
    mkdirSync(join(workspace, "maintenance-failure"), { mode: 0o700 })
    writeFileSync(
      join(workspace, "maintenance-failure", "events.db"),
      "corrupt maintenance database",
      { mode: 0o600 },
    )
    assert.deepEqual(await run("maintenance-stderr-closed", 2), { survived: true, journal: true })
    mkdirSync(join(workspace, "text-log-failure", "daemon.log"), { recursive: true, mode: 0o700 })
    assert.deepEqual(await run("text-log-stderr-closed", 2), { survived: true, failed: true })
    writeFileSync(join(workspace, "corrupt-events.db"), "corrupt event-log fixture", {
      mode: 0o600,
    })
    assert.deepEqual(await run("event-log-stderr-closed", 2), {
      survived: true,
      persistenceAndReportingCauses: true,
    })
    const path = join(workspace, "stderr.log")
    writeFileSync(path, "retained prefix\n", { mode: 0o600 })
    const file = openSync(path, "a")
    try {
      assert.deepEqual(await run("append", file), { appended: true })
    } finally {
      closeSync(file)
    }
    assert.equal(
      readFileSync(path, "utf8"),
      "retained prefix\nfirst 😀\nsecond\ncaller still writable\n",
    )
    assert.equal((await run("cli-stdout-closed", 2)).error.details.phase, "output-flush")
    assert.deepEqual(await run("cli-stderr-closed", 2), { exitCode: 5 })
    const preload = join(workspace, "large-output.ts")
    writeFileSync(
      preload,
      'process.stdout.write("x".repeat(1024*1024));setInterval(()=>{},1000);setTimeout(()=>process.exit(99),2000)',
    )
    const large = Bun.spawnSync([process.execPath, "--preload", preload, executable, "--version"], {
      timeout: 6000,
      killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, LEUCO_HOME: join(workspace, "cli-home") },
    })
    assert.equal(large.exitCode, 0, new TextDecoder().decode(large.stderr))
    assert.equal(
      new TextDecoder().decode(large.stdout),
      `${"x".repeat(1024 * 1024)}${pkg.version}\n`,
    )
    if (process.platform !== "win32") {
      const fifoPath = join(workspace, "blocked-stderr")
      const fifo = Bun.spawnSync(["mkfifo", fifoPath], {
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 65536,
      })
      assert.equal(fifo.exitCode, 0)
      const pipe = openSync(fifoPath, constants.O_RDWR | constants.O_NONBLOCK)
      try {
        const filled = { bytes: 0, full: false }
        const chunk = Buffer.alloc(4096)
        while (filled.bytes < 1024 * 1024) {
          try {
            filled.bytes += writeSync(pipe, chunk)
          } catch (error) {
            if (
              errorDetails(error).some(
                (cause) => cause.code === "EAGAIN" || cause.code === "EWOULDBLOCK",
              )
            ) {
              filled.full = true
              break
            }
            throw error
          }
        }
        assert.equal(filled.full, true)
        assert.deepEqual(await run("backpressure", pipe), { timedOut: true, busy: true })
        const cliFailure = await run("cli-output", pipe)
        assert.equal(cliFailure.error.code, outputDelivery.unconfirmed.errorCode)
        assert.equal(cliFailure.error.details.phase, outputDelivery.unconfirmed.phase)
        const changed = await run("cli-mutation", pipe)
        assert.equal(changed.error.mutationMayHaveOccurred, true)
        assert.equal(changed.error.details.phase, outputDelivery.unconfirmed.phase)
        assert.equal(
          JSON.parse(readFileSync(join(workspace, "cli-mutation", "settings.json"), "utf8")).model,
          "output-probe",
        )
      } finally {
        closeSync(pipe)
      }
    }
    assert.equal(existsSync(join(workspace, "cli-home")), false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
  console.log(
    `Diagnostic output passed: Codex consumer redaction/framing; append/Unicode preserved; caller descriptor remains open; FIFO backpressure ${process.platform === "win32" ? "not verified on Windows" : "exits without forced termination"}`,
  )
}
