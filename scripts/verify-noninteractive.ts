import { readLeucoEvents } from "@/events/read-leuco-events"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"
import { getCliSpecification } from "@/cli/get-cli-specification"
import { serializeCliValue } from "@/cli/serialize-cli-value"
import { writeCliOutput } from "@/cli/write-cli-output"
import { writeCliError } from "@/cli/write-cli-error"
import { CliError } from "@/cli/cli-error"
import { MemoryDiagnosticOutput } from "@/memory-diagnostic-output"

// Native Bun YAML must preserve data without emitting terminal control sequences.
const controlText = `${String.fromCharCode(...Array.from({ length: 33 }, (_, index) => 127 + index))}\u2028\u2029`
const diagnostic = {
  ok: true,
  [controlText]: [controlText, `line one\n${controlText}`, "literal \\u009b"],
  secret: "xoxb-synthetic-serialization-token",
}
const expected = { ...diagnostic, secret: "[redacted]" }
for (const json of [true, false]) {
  const encoded = serializeCliValue(diagnostic, json)
  assert.ok(!/[\u007f-\u009f\u2028\u2029]/u.test(encoded), "CLI emitted raw control characters")
  assert.deepEqual(json ? JSON.parse(encoded) : Bun.YAML.parse(encoded), expected)
  const output = new MemoryDiagnosticOutput()
  const context = {
    json,
    command: "slack call",
    requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
    output,
  }
  await writeCliOutput(diagnostic, context)
  const success = String(output.attempts[0])
  assert.ok(!/[\u007f-\u009f\u2028\u2029]/u.test(success))
  assert.deepEqual((json ? JSON.parse(success) : Bun.YAML.parse(success)).data, expected)
  output.attempts.length = 0
  await writeCliError(
    new CliError("OPERATION_FAILED", controlText),
    json ? ["status", "--json"] : ["status"],
    context,
  )
  const failure = String(output.attempts[0])
  assert.ok(!/[\u007f-\u009f\u2028\u2029]/u.test(failure))
  assert.equal((json ? JSON.parse(failure) : Bun.YAML.parse(failure)).error.message, controlText)
  const cyclic: { self: unknown } = { self: null }
  cyclic.self = cyclic
  for (const details of [cyclic, { value: 1n }, Symbol("no JSON representation")]) {
    output.attempts.length = 0
    await writeCliError(
      new CliError("STATE_CONFLICT", "original failure", details),
      json ? ["restart", "--json"] : ["restart"],
      context,
    )
    const encodedFailure = String(output.attempts[0])
    const recovered = json ? JSON.parse(encodedFailure) : Bun.YAML.parse(encodedFailure)
    z.fromJSONSchema(getCliSpecification().errorSchema).parse(recovered)
    assert.equal(recovered.error.code, "STATE_CONFLICT")
    assert.equal(recovered.error.message, "original failure")
    assert.equal(recovered.error.mutationMayHaveOccurred, true)
    assert.equal(recovered.error.details.phase, "error-details")
    assert.equal(recovered.error.details.originalDetailsAvailable, false)
    assert.ok(recovered.error.details.causes.length > 1)
  }
  process.exitCode = 0
}
assert.equal(serializeCliValue({ message: "normal text" }, false), "message: normal text")

if (process.platform === "win32")
  throw new Error(
    "Native desktop-helper fixtures are not yet validated on Windows; refusing to read the user's real clipboard.",
  )

const repository = resolve(import.meta.dir, "..")
const workspace = realpathSync(mkdtempSync("/tmp/leuco-noinput-"))
const home = join(workspace, "state")
const clipboardHelpers = join(workspace, "clipboard-helpers")
mkdirSync(clipboardHelpers)
for (const name of ["pbpaste", "wl-paste", "xclip", "xsel"])
  writeFileSync(join(clipboardHelpers, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 })

const env = {
  ...process.env,
  LEUCO_HOME: home,
  PATH: clipboardHelpers,
  CODEX_HOME: join(workspace, "codex"),
  LEUCO_VERIFY_TRACE: join(workspace, "trace.jsonl"),
}
const executable = join(repository, "lib/index.ts")
async function run(args: string[], code: number | number[] = 0) {
  const child = Bun.spawn([process.execPath, executable, ...args], {
    cwd: workspace,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const limit = setTimeout(() => child.kill(), 8000)
  try {
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    const expected = typeof code === "number" ? [code] : code
    assert.ok(expected.includes(await child.exited), `${args.join(" ")}\n${stdout}\n${stderr}`)
    return { stdout, stderr }
  } finally {
    clearTimeout(limit)
  }
}
try {
  const status = Bun.YAML.parse((await run(["status"])).stdout)
  z.fromJSONSchema(getCliSpecification(["status"]).commands[0]!.outputSchema).parse(status)
  const yamlHelp = Bun.YAML.parse((await run(["slack", "call", "--help", "--yaml"])).stdout)
  assert.deepEqual(yamlHelp, JSON.parse((await run(["slack", "call", "--help", "--json"])).stdout))
  const stdin = await run(["config", "set", "model", "-"], 2)
  assert.ok(stdin.stderr.includes("stdin input is disabled"))
  const login = await run(["slack", "login", "bot"], 4)
  assert.ok(login.stderr.includes("NEEDS_HUMAN") && /clipboard/i.test(login.stderr))
  await run(["slack", "login", "bot", "--interactive"], 2)
  await run(["slack", "login", "bot", "--bot-token", "xoxb-argument-is-forbidden"], 2)
  await run(["slack", "login"], 2)
  await run(["run"], 2)
  await run(["status", "--yaml", "--json"], 2)
  const terminal: { chunks: Uint8Array[] } = { chunks: [] }
  const tty = Bun.spawn([process.execPath, executable, "slack", "login", "bot"], {
    cwd: workspace,
    env,
    terminal: {
      cols: 80,
      rows: 24,
      data(_terminal, data) {
        terminal.chunks.push(new Uint8Array(data))
      },
    },
  })
  const ttyTimeout = setTimeout(() => tty.kill(), 8000)
  try {
    assert.equal(await tty.exited, 4, "TTY caused an implicit credential prompt")
  } finally {
    clearTimeout(ttyTimeout)
    tty.terminal?.close()
  }
  assert.ok(Buffer.concat(terminal.chunks).toString().includes("NEEDS_HUMAN"))
  const fake = join(clipboardHelpers, "codex")
  writeFileSync(
    fake,
    `#!/bin/sh\nexec '${process.execPath}' '${join(repository, "scripts/fixtures/fake-codex.ts")}' "$@"\n`,
    { mode: 0o700 },
  )
  await run(["start"])
  const fifo = join(workspace, "upload-pipe")
  assert.equal(
    Bun.spawnSync(["mkfifo", fifo], { timeout: 5000, killSignal: "SIGKILL", maxBuffer: 65536 })
      .exitCode,
    0,
  )
  await run(["slack", "upload-file", "--channel", "C123", "--file", fifo], 1)
  const begin = Date.now()
  const timed = await run(["ask", "hold", "--timeout-ms", "80", "--json"], 5)
  const failure = JSON.parse(timed.stderr)
  assert.equal(failure.error.code, "STATE_UNCERTAIN")
  assert.equal(failure.error.mutationMayHaveOccurred, true)
  assert.ok(Date.now() - begin < 3000, "CLI remained blocked after deadline")
  const events = JSON.parse(
    (await run(["events", "--request", failure.requestId, "--json"])).stdout,
  ).data
  assert.ok(events.some((entry: { event: { type: string } }) => entry.event.type === "turn.start"))
  await run(["stop"])
  const retiredOneShot = await run(["run", "--prompt", "hold", "--json"], 2)
  assert.equal(JSON.parse(retiredOneShot.stderr).error.code, "USAGE")
  const notificationProbe: { token: string | null } = { token: null }
  const foregroundOutput: { chunks: Uint8Array[] } = { chunks: [] }
  const foreground = Bun.spawn(
    [process.execPath, executable, "run", "--foreground", "--timeout-ms", "5000"],
    {
      cwd: workspace,
      env: {
        ...env,
        LEUCO_VERIFY_TURN_STDERR: "1",
        LEUCO_VERIFY_NOTIFICATION_SECRET_BOUNDARY: "1",
      },
      terminal: {
        cols: 100,
        rows: 24,
        data(_terminal, chunk) {
          foregroundOutput.chunks.push(new Uint8Array(chunk))
        },
      },
    },
  )
  const foregroundLimit = setTimeout(() => foreground.kill(), 8000)
  try {
    const readyDeadline = performance.now() + 4000
    const readiness = { confirmed: false }
    while (performance.now() < readyDeadline) {
      const observation = await run(["status", "--json"], [0, 5])
      if (observation.stderr.trim()) {
        const failure = JSON.parse(observation.stderr)
        assert.equal(failure.error.code, "STATE_UNCERTAIN")
        assert.equal(failure.error.mutationMayHaveOccurred, false)
      } else if (JSON.parse(observation.stdout).data.ready === true) {
        readiness.confirmed = true
        break
      }
      await Bun.sleep(20)
    }
    assert.ok(readiness.confirmed, "Foreground daemon did not become ready")
    notificationProbe.token = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")).token
    await run(["ask", "tty diagnostic", "--json"])
    await run(["ask", "oversized-failure", "--json"], 1)
    const failedStatus = JSON.parse((await run(["status", "--json"])).stdout)
    assert.ok(failedStatus.data.runtime.lastFailure.message.length <= 4000)
    assert.ok(failedStatus.data.runtime.lastFailure.message.startsWith("status-failure-probe "))
    assert.ok(failedStatus.data.runtime.lastFailure.message.endsWith(" [truncated]"))
    const savedFailure = readLeucoEvents(join(home, "events.db"), 1, { type: "turn.error" })[0]
      ?.event
    assert.equal(savedFailure?.type, "turn.error")
    if (savedFailure?.type !== "turn.error") throw new Error("Missing saved turn failure")
    assert.ok(
      savedFailure.error.length <= 4000,
      "Stored turn failure text exceeded the diagnostic limit",
    )
    assert.equal(savedFailure.error, failedStatus.data.runtime.lastFailure.message)
    assert.equal(savedFailure.error, savedFailure.causes?.[0]?.message)

    assert.ok(typeof notificationProbe.token === "string")
    assert.ok(!JSON.stringify(failedStatus).includes(notificationProbe.token.slice(0, 8)))
    await run(["stop"])
    assert.equal(await foreground.exited, 0, "Foreground terminal probe failed")
  } finally {
    await run(["stop"]).catch(() => {})
    if (foreground.exitCode === null) foreground.kill("SIGKILL")
    await foreground.exited
    clearTimeout(foregroundLimit)
    foreground.terminal?.close()
  }
  const display = Buffer.concat(foregroundOutput.chunks).toString()
  assert.ok(display.includes("terminal-control-probe"), "Foreground logs were not observed")
  assert.ok(
    !display.includes(String.fromCharCode(27)) && !/[\u007f-\u009f]/u.test(display),
    "Foreground logs emitted raw terminal controls",
  )
  assert.ok(!display.includes("xoxb-synthetic"), "Foreground logs exposed an unmasked token")
  assert.ok(display.includes("wss://wss-primary.slack.com/link/?[redacted]"))
  assert.ok(!display.includes("synthetic-socket-ticket"))
  assert.ok(display.includes("wss://[redacted]@wss-primary.slack.com/link/?[redacted]"))
  assert.ok(!display.includes("private-url-"))
  const foregroundEvents = JSON.parse(
    (await run(["events", "--type", "log", "--json"])).stdout,
  ).data
  assert.ok(!JSON.stringify(foregroundEvents).includes("synthetic-socket-ticket"))
  assert.ok(!JSON.stringify(foregroundEvents).includes("private-url-"))
  const unicodeRecord = foregroundEvents.find(
    (entry: { event: { line?: string } }) =>
      entry.event.line ===
      "[truncated stderr line; content omitted before redaction; original chars=12010]",
  )
  assert.ok(unicodeRecord, "Oversized Unicode stderr was not reported")
  assert.ok(
    !JSON.stringify(unicodeRecord).includes("\\ud83d"),
    "Stderr clipping split a Unicode character",
  )
  assert.ok(!display.includes("\\ud83d"), "Foreground display retained a split Unicode character")
  assert.ok(unicodeRecord.event.line.includes("truncated stderr line"))
  const foregroundRecord = foregroundEvents.find((entry: { event: { line?: string } }) =>
    entry.event.line?.includes("terminal-control-probe"),
  )
  assert.equal(typeof foregroundRecord?.event.requestId, "string")
  assert.ok(
    display.includes(
      `[info] requestId=${foregroundRecord.event.requestId} terminal-control-probe\\u009b31m\\u001b[2J [redacted]`,
    ),
    "Foreground diagnostics lost severity, correlation or safe escaping",
  )

  const syntheticSecret = notificationProbe.token
  assert.ok(typeof syntheticSecret === "string")
  assert.ok(
    !JSON.stringify(foregroundEvents).includes(syntheticSecret.slice(0, 8)),
    "Protocol or stderr preview retained part of its synthetic owner secret",
  )
  assert.ok(
    !display.includes(syntheticSecret.slice(0, 8)),
    "Terminal preview retained part of its synthetic owner secret",
  )
  assert.ok(
    foregroundEvents.some((entry: { event: { line?: string } }) =>
      entry.event.line?.includes("[codex non-json] protocol-raw"),
    ),
  )
  assert.ok(
    foregroundEvents.some((entry: { event: { line?: string } }) =>
      entry.event.line?.includes("[codex unknown]"),
    ),
  )

  const notifications = JSON.parse(
    (await run(["events", "--type", "codex.notification", "--json"])).stdout,
  ).data
  assert.ok(
    !JSON.stringify(notifications).includes(syntheticSecret.slice(0, 8)),
    "Notification preview retained part of its synthetic fixture secret",
  )
  assert.ok(
    notifications.some(
      (entry: { event: { method: string } }) =>
        entry.event.method === `probe/${"m".repeat(238)}[redacted]`,
    ),
  )
  assert.ok(
    notifications.some(
      (entry: {
        event: {
          params?: { item?: { tool?: string; durationMs?: number | null; hasResult?: boolean } }
        }
      }) =>
        entry.event.params?.item?.tool === `${"t".repeat(240)}[redacted]` &&
        entry.event.params.item.durationMs === null &&
        entry.event.params.item.hasResult === true,
    ),
  )

  assert.ok(!JSON.stringify(notifications).includes("null-duration-large-result"))

  const data = {
    requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
    text: "line one\nline two: yes\n---\n!tag",
    timestamp: "123.456",
    id: "00123",
    booleanLike: "true",
    code: "xapp-secret-value",
  }
  const decoded = Bun.YAML.parse(serializeCliValue(data, false))
  assert.deepEqual(decoded, { ...data, code: "[redacted]" })
  console.log(
    "Non-interactive passed: YAML/JSON contracts, TTY and open-pipe fail-fast, bounded observation, correlated timeout, no implicit foreground or secret prompt",
  )
} finally {
  await run(["stop"]).catch(() => {})
  rmSync(workspace, { recursive: true, force: true })
}
