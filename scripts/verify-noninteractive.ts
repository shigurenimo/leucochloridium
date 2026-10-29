import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"
import { getCliSpecification } from "@/cli/get-cli-specification"

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
const clipboardPath = `${clipboardHelpers}:${process.env.PATH ?? ""}`

const env = {
  ...process.env,
  LEUCO_HOME: home,
  PATH: clipboardPath,
  CODEX_HOME: join(workspace, "codex"),
  LEUCO_VERIFY_TRACE: join(workspace, "trace.jsonl"),
}
const executable = join(repository, "lib/index.ts")
async function run(args: string[], code = 0) {
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
    assert.equal(await child.exited, code, `${args.join(" ")}\n${stdout}\n${stderr}`)
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
  const fake = join(workspace, "codex-bin")
  writeFileSync(
    fake,
    `#!/bin/sh\nexec '${process.execPath}' '${join(repository, "scripts/fixtures/fake-codex.ts")}' "$@"\n`,
    { mode: 0o700 },
  )
  await run(["start", "--codex-bin", fake])
  const fifo = join(workspace, "upload-pipe")
  assert.equal(Bun.spawnSync(["mkfifo", fifo]).exitCode, 0)
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
  const oneShot = await run(
    ["run", "--codex-bin", fake, "--prompt", "hold", "--timeout-ms", "200", "--json"],
    5,
  )
  assert.equal(JSON.parse(oneShot.stderr).error.code, "STATE_UNCERTAIN")
  const data = {
    requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
    text: "line one\nline two: yes\n---\n!tag",
    timestamp: "123.456",
    id: "00123",
    booleanLike: "true",
    code: "xapp-secret-value",
  }
  const { serializeCliValue } = await import("@/cli/serialize-cli-value")
  const decoded = Bun.YAML.parse(serializeCliValue(data, false))
  assert.deepEqual(decoded, { ...data, code: "[redacted]" })
  console.log(
    "Non-interactive passed: YAML/JSON contracts, TTY and open-pipe fail-fast, bounded observation, correlated timeout, no implicit foreground or secret prompt",
  )
} finally {
  await run(["stop"]).catch(() => {})
  rmSync(workspace, { recursive: true, force: true })
}
