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

const repository = resolve(import.meta.dir, "..")
const workspace = realpathSync(mkdtempSync("/tmp/leuco-"))
const home = join(workspace, "leuco")
const codexHome = join(workspace, "codex")
const trace = join(workspace, "trace.jsonl")
const fake = join(workspace, "codex-bin")
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
const environment = {
  ...process.env,
  LEUCO_HOME: home,
  CODEX_HOME: codexHome,
  LEUCO_VERIFY_TRACE: trace,
}

async function cli(args: string[], success = true, env = environment): Promise<string> {
  const child = Bun.spawn([process.execPath, join(repository, "lib/index.ts"), ...args], {
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
    return output + error
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
function snapshot(): string {
  return JSON.stringify(
    readdirSync(codexHome).map((name) => [name, readFileSync(join(codexHome, name), "utf8")]),
  )
}
const original = snapshot()
try {
  assert.match(await cli(["run", "--codex-bin", fake, "--prompt", "hello"]), /verified reply/)
  assert.equal(existsSync(join(home, "daemon.json")), false)
  assert.equal(existsSync(join(home, "control.sock")), false)
  const initial = frames().find((frame) => frame.method === "thread/start")
  assert.deepEqual(initial?.params, { cwd: workspace })
  assert.deepEqual(frames()[0], {
    env: { CODEX_HOME: codexHome, LEUCO_HOME: home },
    args: ["app-server"],
  })
  const soul = join(workspace, "SOUL.md")
  writeFileSync(soul, "soul instruction")
  await cli(["run", "--codex-bin", fake, "--soul", soul, "--prompt", "hello"])
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
  await cli(["start", "--codex-bin", fake, "--no-soul"])
  assert.equal(JSON.parse(await cli(["status"])).ready, true)
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

  assert.match(await cli(["start", "--codex-bin", fake], false), /already running/)
  assert.match(await cli(["ask", "hello", "--thread", "shared"]), /verified reply/)
  assert.match(await cli(["ask", "hello again", "--thread", "shared"]), /verified reply/)
  const first = JSON.parse(readFileSync(join(home, "state.json"), "utf8")).threads.shared.id
  await cli(["stop"])
  await cli(["start", "--codex-bin", fake, "--no-soul"])
  await cli(["ask", "resume", "--thread", "shared"])
  assert.ok(
    frames().some(
      (frame) => frame.method === "thread/resume" && JSON.stringify(frame.params).includes(first),
    ),
  )
  await cli(["stop"])
  assert.equal(JSON.parse(await cli(["status"])).running, false)
  await cli(
    ["run", "--codex-bin", fake, "--soul", join(workspace, "missing"), "--prompt", "hello"],
    false,
  )
  assert.equal(existsSync(join(home, "daemon.json")), false)
  assert.equal(existsSync(join(home, "control.sock")), false)
  await cli(["run", "--codex-bin", join(workspace, "missing"), "--prompt", "hello"], false)
  assert.equal(existsSync(join(home, "daemon.json")), false)
  const holding = Bun.spawn(
    [
      process.execPath,
      join(repository, "lib/index.ts"),
      "run",
      "--codex-bin",
      fake,
      "--no-soul",
      "--prompt",
      "hold",
    ],
    { env: environment, cwd: workspace, stdout: "ignore", stderr: "pipe" },
  )
  const holdingDeadline = Date.now() + 5000
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
  assert.equal(await holding.exited, 0, await new Response(holding.stderr).text())
  const noHome = { ...environment }
  delete noHome.CODEX_HOME
  await cli(["run", "--codex-bin", fake, "--no-soul", "--prompt", "default home"], true, noHome)
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
  console.log("Single-companion CLI integration passed")
} finally {
  await cli(["stop"]).catch(() => {})
  rmSync(workspace, { force: true, recursive: true })
}
