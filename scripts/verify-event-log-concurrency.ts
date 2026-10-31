import assert from "node:assert/strict"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { readLeucoEvents } from "@/events/read-leuco-events"
import { MemoryDiagnosticOutput } from "@/memory-diagnostic-output"

const count = 100
if (process.argv[2] === "hold" || process.argv[2] === "hold-reader") {
  const database = new Database(process.argv[3])
  try {
    if (process.argv[2] === "hold-reader") database.run("PRAGMA locking_mode = EXCLUSIVE")
    database.run(process.argv[2] === "hold-reader" ? "BEGIN EXCLUSIVE" : "BEGIN IMMEDIATE")
    console.log("locked")
    await Bun.sleep(Number(process.argv[4]))
    database.run("ROLLBACK")
  } finally {
    database.close(true)
  }
} else if (process.argv[2] === "maintenance") {
  const failures: unknown[] = []
  for (const index of Array.from({ length: count }).keys()) {
    const log = new LeucoEventLog({
      eventLogPath: process.argv[3],
      diagnosticOutput: new MemoryDiagnosticOutput(),
    })
    try {
      log.log("info", `maintenance-${index}`)
      if (log.getHealth().failedWrites > 0) failures.push(log.getHealth())
    } finally {
      log.close()
    }
  }
  console.log(JSON.stringify({ failures }))
} else {
  const workspace = mkdtempSync(join(tmpdir(), "leuco-event-concurrency-"))
  const path = join(workspace, "events.db")
  const log = new LeucoEventLog({
    eventLogPath: path,
    diagnosticOutput: new MemoryDiagnosticOutput(),
  })
  const child = Bun.spawn([process.execPath, import.meta.path, "maintenance", path], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000)
  const appended = { count: 0 }
  try {
    for (const index of Array.from({ length: count * 3 }).keys()) {
      log.log("info", `daemon-${index}`)
      appended.count += 1
      await Bun.sleep(1)
    }
    assert.equal(await child.exited, 0, await stderr)
    const maintenance = JSON.parse(await stdout)
    assert.equal(
      maintenance.failures.length,
      0,
      JSON.stringify(maintenance.failures).slice(0, 5000),
    )
    assert.equal(log.getHealth().failedWrites, 0, JSON.stringify(log.getHealth()))
    const events = readLeucoEvents(path, 1000)
    assert.equal(events.length, appended.count + count)
    assert.equal(new Set(events.map((entry) => entry.seq)).size, events.length)
    assert.equal(
      new Set(events.map((entry) => (entry.event.type === "log" ? entry.event.line : "unexpected")))
        .size,
      events.length,
    )
    const hold = async (duration: number, line: string) => {
      const holder = Bun.spawn(
        [process.execPath, import.meta.path, "hold", path, String(duration)],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      )
      const expiry = setTimeout(() => holder.kill("SIGKILL"), 4000)
      try {
        const reader = holder.stdout.getReader()
        try {
          assert.ok(new TextDecoder().decode((await reader.read()).value).includes("locked"))
        } finally {
          reader.releaseLock()
        }
        const started = performance.now()
        log.log("info", line)
        const elapsed = performance.now() - started
        assert.equal(await holder.exited, 0, await new Response(holder.stderr).text())
        return elapsed
      } finally {
        clearTimeout(expiry)
        if (holder.exitCode === null) holder.kill("SIGKILL")
        await holder.exited
      }
    }
    await hold(80, "waited without replay")
    assert.equal(log.getHealth().failedWrites, 0)
    const elapsed = await hold(800, "never replay this failure")
    assert.ok(elapsed >= 150 && elapsed < 2000, `unbounded writer wait: ${elapsed}ms`)
    assert.equal(log.getHealth().failedWrites, 1)
    assert.ok(
      log.getHealth().lastPersistError?.causes.some((cause) => cause.code === "SQLITE_BUSY"),
    )
    log.log("info", "recovered without replay")
    assert.equal(log.getHealth().lastWriteFailed, false)
    const recovered = readLeucoEvents(path, 1000)
    assert.equal(recovered.length, events.length + 2)
    assert.equal(
      recovered.filter(
        (entry) => entry.event.type === "log" && entry.event.line === "waited without replay",
      ).length,
      1,
    )
    assert.equal(
      recovered.filter(
        (entry) => entry.event.type === "log" && entry.event.line === "never replay this failure",
      ).length,
      0,
    )
    const secret = 'synthetic"private\\\nvalue'
    log.addRedactionSecrets([secret])
    log.append({
      ts: Date.now(),
      type: "codex.notification",
      runtime: "leuco",
      method: "redaction-probe",
      params: { [secret]: [{ value: secret }] },
    })
    const masked = readLeucoEvents(path, 1)[0]?.event
    assert.deepEqual(masked?.type === "codex.notification" ? masked.params : null, {
      "[redacted]": [{ value: "[redacted]" }],
    })
    assert.equal(log.getHealth().failedWrites, 1, "redaction lost a valid event")
    const readerPath = join(workspace, "reader-events.db")
    const readerLog = new LeucoEventLog({ eventLogPath: readerPath, diagnosticOutput: null })
    readerLog.log("error", "retained failure")
    readerLog.close()
    for (const duration of [80, 800]) {
      const holder = Bun.spawn(
        [process.execPath, import.meta.path, "hold-reader", readerPath, String(duration)],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      )
      const expiry = setTimeout(() => holder.kill("SIGKILL"), 4000)
      try {
        const reader = holder.stdout.getReader()
        try {
          assert.ok(new TextDecoder().decode((await reader.read()).value).includes("locked"))
        } finally {
          reader.releaseLock()
        }
        const started = performance.now()
        if (duration === 80) {
          const saved = readLeucoEvents(readerPath, 10, { failuresOnly: true })
          assert.equal(saved.length, 1, "short read lock lost saved history")
          assert.equal(saved[0]?.event.type, "log")
        } else {
          assert.throws(
            () => readLeucoEvents(readerPath, 10),
            (error: unknown) =>
              error instanceof Error && Reflect.get(error, "code") === "SQLITE_BUSY",
            "long read lock was hidden as successful empty history",
          )
          const elapsed = performance.now() - started
          assert.ok(elapsed >= 150 && elapsed < 2000, `unbounded reader wait: ${elapsed}ms`)
        }
        assert.equal(await holder.exited, 0, await new Response(holder.stderr).text())
      } finally {
        clearTimeout(expiry)
        if (holder.exitCode === null) holder.kill("SIGKILL")
        await holder.exited
      }
    }
    assert.equal(readLeucoEvents(readerPath, 10).length, 1, "reader mutated saved history")
    console.log(
      "Event concurrency passed: daemon writes and maintenance reopen/retention preserve every unique event; short locks wait, long locks fail within budget without replay",
    )
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    log.close()
    rmSync(workspace, { recursive: true, force: true })
  }
}
