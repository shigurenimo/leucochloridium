import pkg from "leuco/package.json" with { type: "json" }
import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { waitForDaemonReady } from "@/daemon/wait-for-daemon-ready"

const repository = resolve(import.meta.dir, "..")
const workspace = realpathSync(mkdtempSync("/tmp/leuco-"))
const home = join(workspace, "leuco")
const codexHome = join(workspace, "codex")
const trace = join(workspace, "trace.jsonl")
const fakeBin = join(workspace, "bin")
mkdirSync(fakeBin)
const fake = join(fakeBin, "codex")
mkdirSync(home)
mkdirSync(codexHome)
writeFileSync(join(codexHome, "config.toml"), 'developer_instructions = "native instruction"\n')
writeFileSync(join(codexHome, "auth.json"), "sentinel")
writeFileSync(
  fake,
  `#!/bin/sh\nexec '${process.execPath}' '${join(repository, "scripts/fixtures/fake-codex.ts")}' "$@"\n`,
  { mode: 0o700 },
)
chmodSync(fake, 0o700)
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: fakeBin,
  LEUCO_HOME: home,
  CODEX_HOME: codexHome,
  LEUCO_VERIFY_TRACE: trace,
}

async function cli(args: string[], success = true, env = environment): Promise<string> {
  const child = Bun.spawn([process.execPath, join(repository, "lib/index.ts"), ...args, "--json"], {
    env,
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 20_000)
  try {
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    const code = await child.exited
    assert.equal(code === 0, success, `${args.join(" ")}: ${code}\n${output}\n${error}`)
    if (!success) return output + error
    const envelope = JSON.parse(output)
    return typeof envelope.data?.reply === "string"
      ? envelope.data.reply
      : JSON.stringify(envelope.data)
  } finally {
    clearTimeout(timer)
  }
}
function frames(): Record<string, unknown>[] {
  return readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}
async function freshReply(
  prompt: string,
  options: string[] = [],
  env = environment,
): Promise<string> {
  await cli(["start", ...options], true, env)
  try {
    return await cli(["ask", prompt], true, env)
  } finally {
    await cli(["stop"], true, env)
  }
}
function snapshot(): string {
  return JSON.stringify(
    readdirSync(codexHome).map((name) => [name, readFileSync(join(codexHome, name), "utf8")]),
  )
}
const original = snapshot()
try {
  assert.match(
    await freshReply("hello", [], {
      ...environment,
      slack_bot_token: "synthetic-secret",
      Slack_App_Token: "synthetic-secret",
      Leuco_Slack_Bot_Token: "synthetic-secret",
      leuco_slack_app_token: "synthetic-secret",
      Leuco_Home: "/obsolete",
      leuco_project_id: "obsolete",
      LEUCO_VERIFY_ENV_GUARD: "1",
    }),
    /verified reply/,
  )
  assert.deepEqual(frames().find((frame) => frame.environmentGuard)?.environmentGuard, {
    slackTokenKeys: [],
    leucoHomeKeys: ["LEUCO_HOME"],
    obsoleteProjectKeys: [],
  })
  assert.equal(existsSync(join(home, "daemon.json")), false)
  assert.equal(existsSync(join(home, "control.sock")), false)
  assert.deepEqual(frames().find((frame) => frame.method === "initialize")?.params, {
    clientInfo: { name: "leuco", title: "leucochloridium", version: pkg.version },
  })
  const initial = frames().find((frame) => frame.method === "thread/start")
  assert.deepEqual(initial?.params, { cwd: workspace })
  assert.deepEqual(frames()[0], {
    env: { CODEX_HOME: codexHome, LEUCO_HOME: home },
    args: ["app-server"],
  })
  const soul = join(workspace, "SOUL.md")
  writeFileSync(soul, "soul instruction")
  await freshReply("hello", ["--soul", "SOUL.md"])
  assert.equal(JSON.parse(readFileSync(join(home, "launch.json"), "utf8")).soul, soul)
  const selected = frames()
    .filter((frame) => frame.method === "thread/start")
    .at(-1)
  assert.deepEqual(selected?.params, {
    cwd: workspace,
    developerInstructions: "native instruction\n\nsoul instruction",
  })
  await cli(["config", "set", "soul", JSON.stringify(soul)])
  await cli([
    "schedules",
    "add",
    "--name",
    "once",
    "--run-at",
    new Date(Date.now() - 1000).toISOString(),
    "--prompt",
    "scheduled-check",
  ])
  await cli(["start", "--no-soul", "--cwd", "."])
  const startedStatus = JSON.parse(await cli(["status"]))
  assert.equal(startedStatus.ready, true)
  assert.equal(startedStatus.cwd, workspace)
  assert.equal(JSON.parse(readFileSync(join(home, "launch.json"), "utf8")).cwd, workspace)
  assert.deepEqual(
    startedStatus.runtime.connections.find(
      (connection: { type: string }) => connection.type === "schedule",
    ).health.cleanup,
    { pending: 0, nextRetryAt: null },
  )
  const scheduleDeadline = Date.now() + 5000
  while (
    Date.now() < scheduleDeadline &&
    JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).schedules.length > 0
  )
    await Bun.sleep(20)
  assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).schedules.length, 0)
  assert.ok(
    Object.keys(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).scheduleLastFiredAt)
      .length > 0,
  )
  assert.ok(
    frames().some(
      (frame) =>
        frame.method === "turn/start" && JSON.stringify(frame.params).includes("scheduled-check"),
    ),
  )

  const firedEvents = JSON.parse(await cli(["events", "--type", "schedule.fired", "--limit", "1"]))
  assert.equal(typeof firedEvents[0]?.event.requestId, "string")
  assert.ok(
    readFileSync(join(home, "daemon.log"), "utf8").includes(
      `[info] requestId=${firedEvents[0].event.requestId} [schedule] firing once (one-shot)`,
    ),
    "Text logs lost the request ID retained in structured history",
  )

  assert.match(await cli(["start"], false), /already running/)
  assert.match(await cli(["ask", "hello", "--thread", "shared"]), /verified reply/)
  assert.match(await cli(["ask", "hello again", "--thread", "shared"]), /verified reply/)
  const first = JSON.parse(readFileSync(join(home, "state.json"), "utf8")).threads.shared.id
  const literalIds = new Map<string, string>()
  for (const key of ["__proto__", "constructor", "toString"]) {
    const startsBefore = frames().filter((frame) => frame.method === "thread/start").length
    await cli(["ask", "literal key first", "--thread", key])
    await cli(["ask", "literal key second", "--thread", key])
    assert.equal(
      frames().filter((frame) => frame.method === "thread/start").length,
      startsBefore + 1,
    )
    const sessions = JSON.parse(await cli(["session", "list"]))
    assert.equal(Object.hasOwn(sessions, key), true)
    literalIds.set(key, sessions[key].id)
  }
  await cli(["stop"])
  await cli(["start", "--no-soul"])
  await cli(["ask", "resume", "--thread", "shared"])
  for (const key of literalIds.keys()) {
    await cli(["ask", "literal key resume", "--thread", key])
    assert.ok(
      frames().some(
        (frame) =>
          frame.method === "thread/resume" &&
          JSON.stringify(frame.params).includes(literalIds.get(key)!),
      ),
    )
  }
  assert.ok(
    frames().some(
      (frame) => frame.method === "thread/resume" && JSON.stringify(frame.params).includes(first),
    ),
  )
  await cli(["stop"])
  assert.equal(JSON.parse(await cli(["status"])).running, false)
  const malformedSoul = join(workspace, "malformed-soul.md")
  writeFileSync(malformedSoul, Uint8Array.from([0xe3, 0x81]))
  const threadStartsBeforeMalformedSoul = frames().filter(
    (frame) => frame.method === "thread/start",
  ).length
  const malformedSoulFailure = await cli(["start", "--soul", malformedSoul], false)
  assert.match(malformedSoulFailure, /SOUL file is not valid UTF-8/)
  const malformedSoulDoctor = JSON.parse(await cli(["doctor"], false))
  assert.equal(malformedSoulDoctor.error.code, "CHECK_FAILED")
  assert.equal(malformedSoulDoctor.error.details.soulExists, false)
  assert.ok(
    malformedSoulDoctor.error.details.failures.some(
      (failure: { phase: string; causes: unknown }) =>
        failure.phase === "soul" &&
        JSON.stringify(failure.causes).includes("SOUL file is not valid UTF-8"),
    ),
  )
  assert.equal(existsSync(join(home, "daemon.json")), false)
  assert.equal(existsSync(join(home, "control.sock")), false)
  assert.equal(
    frames().filter((frame) => frame.method === "thread/start").length,
    threadStartsBeforeMalformedSoul,
  )
  await cli(["start", "--soul", join(workspace, "missing")], false)
  assert.equal(existsSync(join(home, "daemon.json")), false)
  assert.equal(existsSync(join(home, "control.sock")), false)
  await cli(["start"], false, {
    ...environment,
    PATH: join(workspace, "missing-bin"),
  })
  assert.equal(existsSync(join(home, "daemon.json")), false)
  const holding = Bun.spawn(
    [process.execPath, join(repository, "lib/index.ts"), "run", "--foreground", "--no-soul"],
    { env: environment, cwd: workspace, stdout: "ignore", stderr: "pipe" },
  )
  await waitForDaemonReady({
    home,
    pid: holding.pid,
    timeoutMs: 5000,
    pollMs: 20,
    getExitError: () =>
      holding.exitCode === null ? null : new Error(`Foreground exited: ${holding.exitCode}`),
  })
  const holdingDeadline = Date.now() + 5000
  const heldRequest = cli(["ask", "hold"], false)
  while (
    Date.now() < holdingDeadline &&
    !frames().some(
      (frame) => frame.method === "turn/start" && JSON.stringify(frame.params).includes('"hold"'),
    )
  )
    await Bun.sleep(20)
  assert.ok(
    frames().some(
      (frame) => frame.method === "turn/start" && JSON.stringify(frame.params).includes('"hold"'),
    ),
  )
  await cli(["stop"])
  await heldRequest
  assert.equal(await holding.exited, 0, await new Response(holding.stderr).text())
  const noHome = { ...environment }
  delete noHome.CODEX_HOME
  await freshReply("default home", ["--no-soul"], noHome)
  assert.ok(
    frames().some((frame) => "env" in frame && !JSON.stringify(frame.env).includes("CODEX_HOME")),
  )
  assert.equal(snapshot(), original)
  assert.equal(existsSync(join(home, "projects")), false)
  assert.equal(existsSync(join(home, ".codex")), false)
  for (const name of ["settings.json", "state.json", "events.db"])
    assert.equal(statSync(join(home, name)).mode & 0o777, 0o600)
  assert.equal(statSync(home).mode & 0o777, 0o700)
  await cli(["session", "reset", "shared"])
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).threads.shared, undefined)
  for (const key of literalIds.keys()) {
    await cli(["session", "reset", key])
    assert.equal(Object.hasOwn(JSON.parse(await cli(["session", "list"])), key), false)
  }
  const recoveryHome = join(workspace, "instruction-recovery")
  const recoveryTrace = join(workspace, "instruction-recovery.jsonl")
  const nativeInstructions = join(workspace, "native-instructions.txt")
  const resumeIdentity = join(workspace, "resume-thread-id.txt")
  const startIdentity = join(workspace, "start-thread-id.txt")
  const turnIdentity = join(workspace, "turn-id.txt")
  const earlyNotifications = join(workspace, "early-notifications.txt")
  const resumeError = join(workspace, "resume-error.txt")
  const turnText = join(workspace, "turn-text.txt")
  const recoverySoul = join(workspace, "recovery-SOUL.md")
  writeFileSync(nativeInstructions, "native original")
  writeFileSync(resumeIdentity, "unexpected-before-valid-resume")
  writeFileSync(recoverySoul, "startup extra")
  const recoveryEnv = {
    ...environment,
    LEUCO_HOME: recoveryHome,
    LEUCO_VERIFY_TRACE: recoveryTrace,
    LEUCO_VERIFY_NATIVE_INSTRUCTIONS_FILE: nativeInstructions,
    LEUCO_VERIFY_RESUME_THREAD_ID_FILE: resumeIdentity,
    LEUCO_VERIFY_START_THREAD_ID_FILE: startIdentity,
    LEUCO_VERIFY_TURN_ID_FILE: turnIdentity,
    LEUCO_VERIFY_EARLY_NOTIFICATIONS_FILE: earlyNotifications,
    LEUCO_VERIFY_RESUME_ERROR_FILE: resumeError,
    LEUCO_VERIFY_TURN_TEXT_FILE: turnText,
  }
  const recoveryFrames = (): Record<string, unknown>[] =>
    readFileSync(recoveryTrace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
  const terminateFakeChild = async () => {
    const status = JSON.parse(await cli(["status"], true, recoveryEnv))
    const pid = status.runtime.codex.pid
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    process.kill(pid, "SIGKILL")
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const current = JSON.parse(await cli(["status"], true, recoveryEnv))
      if (!current.runtime.codexRunning) return
      await Bun.sleep(20)
    }
    throw new Error("Fake Codex exit was not observed")
  }
  try {
    await cli(["start", "--soul", recoverySoul], true, recoveryEnv)
    await cli(["ask", "before reconnect"], true, recoveryEnv)
    writeFileSync(nativeInstructions, "native changed")
    writeFileSync(recoverySoul, "edited while running")
    await terminateFakeChild()
    await cli(["ask", "after instruction change"], true, recoveryEnv)
    const newStarts = recoveryFrames().filter((frame) => frame.method === "thread/start")
    assert.equal(newStarts.length, 2)
    assert.deepEqual(newStarts[1]?.params, {
      cwd: workspace,
      developerInstructions: "native changed\n\nstartup extra",
    })
    assert.equal(recoveryFrames().filter((frame) => frame.method === "thread/resume").length, 0)
    const savedConversation = JSON.parse(readFileSync(join(recoveryHome, "state.json"), "utf8"))
      .threads.cli
    writeFileSync(resumeIdentity, savedConversation.id)
    await terminateFakeChild()
    await cli(["ask", "unchanged instructions"], true, recoveryEnv)
    assert.equal(recoveryFrames().filter((frame) => frame.method === "thread/start").length, 2)
    assert.equal(recoveryFrames().filter((frame) => frame.method === "thread/resume").length, 1)
    assert.equal(recoveryFrames().filter((frame) => frame.method === "config/read").length, 3)
    assert.equal(recoveryFrames().filter((frame) => frame.method === "turn/start").length, 3)
    writeFileSync(resumeIdentity, "unexpected-conversation")
    await terminateFakeChild()
    const mismatch = await cli(["ask", "must not dispatch"], false, recoveryEnv)
    assert.match(mismatch, /Codex resumed a different conversation/)
    const failedRequestId = JSON.parse(mismatch).requestId
    const mismatchEvents = JSON.parse(
      await cli(["events", "--request", failedRequestId], true, recoveryEnv),
    )
    assert.ok(
      mismatchEvents.some(
        (row: { event: { type: string; causes?: Array<{ code: string | null }> } }) =>
          row.event.type === "turn.error" &&
          row.event.causes?.some((cause) => cause.code === "CODEX_THREAD_MISMATCH"),
      ),
    )
    assert.equal(recoveryFrames().filter((frame) => frame.method === "turn/start").length, 3)
    assert.deepEqual(
      JSON.parse(readFileSync(join(recoveryHome, "state.json"), "utf8")).threads.cli,
      savedConversation,
    )
    writeFileSync(resumeIdentity, savedConversation.id)
    await cli(["ask", "correct resume after mismatch"], true, recoveryEnv)
    assert.equal(recoveryFrames().filter((frame) => frame.method === "thread/start").length, 2)
    assert.equal(recoveryFrames().filter((frame) => frame.method === "turn/start").length, 4)
    writeFileSync(startIdentity, "")
    const blank = await cli(
      ["ask", "must not use blank ID", "--thread", "invalid-created"],
      false,
      recoveryEnv,
    )
    assert.match(blank, /Codex thread ID must not be blank/)
    assert.equal(recoveryFrames().filter((frame) => frame.method === "turn/start").length, 4)
    assert.equal(
      JSON.parse(readFileSync(join(recoveryHome, "state.json"), "utf8")).threads["invalid-created"],
      undefined,
    )
    rmSync(startIdentity)
    await cli(
      ["ask", "valid creation after blank ID", "--thread", "invalid-created"],
      true,
      recoveryEnv,
    )
    assert.equal(recoveryFrames().filter((frame) => frame.method === "turn/start").length, 5)
    writeFileSync(turnIdentity, "")
    const invalidTurn = await cli(["ask", "unverified invalid turn"], false, recoveryEnv)
    assert.match(invalidTurn, /Codex turn ID must not be blank/)
    assert.equal(JSON.parse(invalidTurn).error.mutationMayHaveOccurred, true)
    assert.equal(recoveryFrames().filter((frame) => frame.method === "turn/start").length, 6)
    rmSync(turnIdentity)
    await cli(["ask", "explicit request after invalid turn"], true, recoveryEnv)
    assert.equal(recoveryFrames().filter((frame) => frame.method === "turn/start").length, 7)
    const beforeEarly = recoveryFrames().filter((frame) => frame.method === "turn/start").length
    for (const mode of ["small", "count", "bytes"]) {
      writeFileSync(earlyNotifications, mode)
      const reply = await cli(
        ["ask", `pending notifications ${mode}`],
        mode === "small",
        recoveryEnv,
      )
      if (mode !== "small") {
        assert.match(reply, /pending turn notifications exceeded limit/)
        assert.equal(JSON.parse(reply).error.mutationMayHaveOccurred, true)
      }
    }
    rmSync(earlyNotifications)
    await cli(["ask", "explicit request after early notification overflow"], true, recoveryEnv)
    assert.equal(
      recoveryFrames().filter((frame) => frame.method === "turn/start").length,
      beforeEarly + 4,
      "pending notification overflow replayed a previous request",
    )
    const beforeFailure = recoveryFrames()
    const retainedMapping = JSON.parse(readFileSync(join(recoveryHome, "state.json"), "utf8"))
      .threads.cli
    writeFileSync(resumeIdentity, retainedMapping.id)
    writeFileSync(resumeError, "model")
    await terminateFakeChild()
    const unrelatedMissing = await cli(
      ["ask", "must retain history for model failure"],
      false,
      recoveryEnv,
    )
    assert.match(unrelatedMissing, /model not found/)
    const modelFailureEvents = JSON.parse(
      await cli(["events", "--request", JSON.parse(unrelatedMissing).requestId], true, recoveryEnv),
    )
    assert.ok(
      modelFailureEvents.some(
        (row: { event: { type: string; causes?: Array<{ name: string; code: string | null }> } }) =>
          row.event.type === "turn.error" &&
          row.event.causes?.some(
            (cause) => cause.name === "CodexRpcError" && cause.code === "-32600",
          ),
      ),
      "Codex RPC code was lost from structured failure history",
    )

    assert.deepEqual(
      JSON.parse(readFileSync(join(recoveryHome, "state.json"), "utf8")).threads.cli,
      retainedMapping,
    )
    for (const method of ["thread/start", "turn/start"]) {
      assert.equal(
        recoveryFrames().filter((frame) => frame.method === method).length,
        beforeFailure.filter((frame) => frame.method === method).length,
      )
    }
    rmSync(resumeError)
    await cli(["ask", "explicit recovery after model failure"], true, recoveryEnv)
    assert.deepEqual(
      JSON.parse(readFileSync(join(recoveryHome, "state.json"), "utf8")).threads.cli,
      retainedMapping,
    )
    writeFileSync(resumeError, "missing")
    await terminateFakeChild()
    await cli(["ask", "explicit request for genuinely missing rollout"], true, recoveryEnv)
    assert.notEqual(
      JSON.parse(readFileSync(join(recoveryHome, "state.json"), "utf8")).threads.cli.id,
      retainedMapping.id,
    )
    assert.equal(
      recoveryFrames().filter((frame) => frame.method === "thread/start").length,
      beforeFailure.filter((frame) => frame.method === "thread/start").length + 1,
    )
    assert.equal(
      recoveryFrames().filter((frame) => frame.method === "turn/start").length,
      beforeFailure.filter((frame) => frame.method === "turn/start").length + 2,
    )
    rmSync(resumeError)
    writeFileSync(
      resumeIdentity,
      JSON.parse(readFileSync(join(recoveryHome, "state.json"), "utf8")).threads.cli.id,
    )
    for (const mode of ["internal-history", "invalid-history"]) {
      const mapping = JSON.parse(readFileSync(join(recoveryHome, "state.json"), "utf8")).threads.cli
      const beforeHistory = recoveryFrames()
      writeFileSync(resumeError, mode)
      await terminateFakeChild()
      await cli(["ask", `history response ${mode}`], mode === "invalid-history", recoveryEnv)
      const afterMapping = JSON.parse(readFileSync(join(recoveryHome, "state.json"), "utf8"))
        .threads.cli
      if (mode === "internal-history") assert.deepEqual(afterMapping, mapping)
      else assert.notEqual(afterMapping.id, mapping.id)
      for (const method of ["thread/start", "turn/start"]) {
        assert.equal(
          recoveryFrames().filter((frame) => frame.method === method).length,
          beforeHistory.filter((frame) => frame.method === method).length +
            (mode === "invalid-history" ? 1 : 0),
        )
      }
      rmSync(resumeError)
      writeFileSync(resumeIdentity, afterMapping.id)
      if (mode === "internal-history") {
        await cli(["ask", "explicit recovery after ambiguous history error"], true, recoveryEnv)
        assert.deepEqual(
          JSON.parse(readFileSync(join(recoveryHome, "state.json"), "utf8")).threads.cli,
          mapping,
        )
      }
    }
    const beforeTextOverflow = recoveryFrames().filter(
      (frame) => frame.method === "turn/start",
    ).length
    for (const mode of ["deltas", "final", "legacy", "count"]) {
      writeFileSync(turnText, mode)
      const overflow = await cli(["ask", `oversized turn text ${mode}`], false, recoveryEnv)
      assert.match(overflow, /Codex turn text exceeded limit/)
      assert.equal(JSON.parse(overflow).error.mutationMayHaveOccurred, true)
      if (mode === "legacy") {
        const notifications = JSON.parse(
          await cli(
            ["events", "--type", "codex.notification", "--request", JSON.parse(overflow).requestId],
            true,
            recoveryEnv,
          ),
        )
        const completed = notifications.find(
          (entry: { event: { method?: string } }) => entry.event.method === "item/completed",
        )
        assert.ok(completed, "Missing legacy completion summary")
        assert.equal(completed.event.params.item.phase, null)
        assert.equal(completed.event.params.item.textChars, 2_400_000)
        assert.equal(Object.hasOwn(completed.event.params.item, "text"), false)
        assert.equal(Object.hasOwn(completed.event.params, "preview"), false)
      }
    }
    rmSync(turnText)
    assert.equal(
      await cli(["ask", "explicit request after text overflow"], true, recoveryEnv),
      "verified reply",
    )
    assert.equal(
      recoveryFrames().filter((frame) => frame.method === "turn/start").length,
      beforeTextOverflow + 5,
      "Text overflow replayed a previous request",
    )
  } finally {
    await cli(["stop"], true, recoveryEnv)
  }
  console.log("Single-companion CLI integration passed")
} finally {
  await cli(["stop"]).catch(() => {})
  rmSync(workspace, { force: true, recursive: true })
}
