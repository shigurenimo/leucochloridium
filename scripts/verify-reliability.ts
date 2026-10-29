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
} from "node:fs"
import { join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { requestDaemon } from "@/daemon/request-daemon"
import { readLeucoEvents } from "@/events/read-leuco-events"
import { isProcessAlive } from "@/daemon/daemon-lease"

const repository = resolve(import.meta.dir, "..")
const workspace = realpathSync(mkdtempSync("/tmp/leuco-reliability-"))
const home = join(workspace, "state")
const trace = join(workspace, "trace.jsonl")
const fake = join(workspace, "codex")
writeFileSync(
  fake,
  `#!/bin/sh\nexec '${process.execPath}' '${join(repository, "scripts/fixtures/fake-codex.ts")}' "$@"\n`,
  { mode: 0o700 },
)
const env = {
  ...process.env,
  LEUCO_HOME: home,
  LEUCO_VERIFY_TRACE: trace,
  LEUCO_VERIFY_CODEX: fake,
}
const cliPath = join(repository, "lib/index.ts")
const processes: Array<ReturnType<typeof Bun.spawn>> = []
function spawn(args: string[], stateHome = home) {
  const child = Bun.spawn([process.execPath, cliPath, ...args, "--json"], {
    cwd: workspace,
    env: { ...env, LEUCO_HOME: stateHome },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  processes.push(child)
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
  const timeout = setTimeout(() => child.kill(), 8000)
  try {
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    assert.equal(await child.exited, expected, `${stdout}\n${stderr}`)
    return JSON.parse(expected === 0 ? stdout : stderr)
  } finally {
    clearTimeout(timeout)
  }
}
async function cli(args: string[], expected = 0) {
  return result(spawn(args), expected)
}
async function until<T>(read: () => Promise<T>, accept: (observation: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const observed = await read()
      if (accept(observed)) return observed
    } catch {}
    await Bun.sleep(30)
  }
  throw new Error("Expected runtime observation did not arrive within 5s")
}
try {
  await cli(["start", "--codex-bin", fake])
  const first = (await cli(["status"])).data
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
  const database = new Database(join(home, "events.db"))
  database.exec("BEGIN IMMEDIATE")
  try {
    assert.equal((await cli(["ask", "sink-locked"])).data.reply, "verified reply")
    const status = (await cli(["status"])).data
    assert.equal(status.runtime.logs.lastWriteFailed, true)
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
  await cli(["ask", "sink-recovered"])
  assert.equal((await cli(["status"])).data.runtime.logs.lastWriteFailed, false)
  assert.equal((await cli(["doctor"])).data.healthy, true)
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
    assert.ok((await cli(["events"])).data.length > 0)
    assert.ok(
      Date.now() - startedAt < 2000,
      "Saved history was blocked by unavailable daemon control",
    )
  } finally {
    rmSync(join(home, "daemon.json"))
  }

  for (const mode of ["throw", "reject", "null", "recover"]) {
    const faultHome = join(workspace, mode)
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
      mode === "null" ? /asynchronous failure: null/ : /injected asynchronous failure/,
    )
    if (mode !== "null") assert.ok(JSON.stringify(outcome).includes("injected root cause"))
    assert.equal(JSON.stringify(outcome).includes("xoxb-reliability-secret"), false)
    const events = readLeucoEvents(join(faultHome, "events.db"), 100)
    assert.ok(
      events.some(
        (entry) =>
          entry.event.type === "log" &&
          entry.event.level === "error" &&
          entry.event.causes?.some((cause) =>
            cause.message.includes(mode === "null" ? "null" : "injected root cause"),
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
  await result(spawn(["start", "--codex-bin", fake], degradedHome))
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
  assert.ok(
    readFileSync(join(degradedHome, "daemon.log"), "utf8").includes(answer.requestId),
    "Volatile events were not mirrored to bounded text logs",
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
} finally {
  await cli(["stop"]).catch(() => {})
  for (const child of processes) if (child.exitCode === null) child.kill()
  rmSync(workspace, { recursive: true, force: true })
}
