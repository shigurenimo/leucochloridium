import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NodeClipboard } from "@/clipboard/node-clipboard"
import { ClipboardReadError } from "@/clipboard/clipboard-read-error"
import { manageSlackCredentials } from "@/cli/manage-slack-credentials"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { isProcessAlive } from "@/daemon/daemon-lease"

if (process.platform === "win32")
  throw new Error(
    "Native desktop-helper fixtures are not yet validated on Windows; refusing to read the user's real clipboard.",
  )

const workspace = realpathSync(mkdtempSync("/tmp/leuco-clipboard-"))
const helpers = join(workspace, "bin")
const empty = join(workspace, "empty")
mkdirSync(helpers)
mkdirSync(empty)
const control = join(workspace, "control.json")
const pidFile = join(workspace, "reader.pid")
const fixture = join(workspace, "reader.ts")
writeFileSync(
  fixture,
  `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const control = JSON.parse(readFileSync(${JSON.stringify(control)}, "utf8"));
if (control.mode === "hang") { setInterval(() => {}, 1000) }
else if (control.mode === "fail") { process.stderr.write(control.text); process.exit(1) }
else process.stdout.write(control.text);
`,
)
for (const name of ["pbpaste", "wl-paste", "xclip", "xsel"])
  writeFileSync(join(helpers, name), `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, {
    mode: 0o700,
  })
const originalPath = process.env.PATH
const valid = "xoxb-clipboard-test-secret"
const clipboard = new NodeClipboard()
const store = new MemoryLeucoStore()
const credentials = new MemoryCredentialStore()
try {
  process.env.PATH = `${helpers}:${originalPath ?? ""}`
  writeFileSync(control, JSON.stringify({ mode: "read", text: valid }))
  const saved = await manageSlackCredentials({
    action: "login",
    kind: "bot",
    clipboard,
    store,
    credentials,
  })
  assert.equal(JSON.stringify(saved).includes("clipboard-test-secret"), false)
  assert.equal(credentials.entries.size, 1)
  assert.equal(
    credentials.entries.get(store.loadSettings().slack!.credential),
    JSON.stringify({ botToken: valid }),
  )
  writeFileSync(control, JSON.stringify({ mode: "read", text: "xapp-clipboard-test-secret" }))
  const completed = await manageSlackCredentials({
    action: "login",
    kind: "app",
    clipboard,
    store,
    credentials,
  })
  assert.equal(JSON.stringify(completed).includes('"complete":true'), true)
  const reference = store.loadSettings().slack!.credential
  for (const mode of ["invalid", "json", "oversize", "fail", "hang"]) {
    const text =
      mode === "oversize"
        ? "x".repeat(100000)
        : mode === "json"
          ? JSON.stringify({ botToken: valid, appToken: "xapp-clipboard-test-secret" })
          : "unrelated text xoxb-sensitive-clipboard"
    writeFileSync(
      control,
      JSON.stringify({
        mode: mode === "invalid" || mode === "json" || mode === "oversize" ? "read" : mode,
        text,
      }),
    )
    const startedAt = Date.now()
    const failure = await manageSlackCredentials({
      action: "login",
      kind: "bot",
      clipboard,
      store,
      credentials,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    assert.ok(failure instanceof Error)
    assert.equal(String(failure).includes("sensitive-clipboard"), false)
    assert.ok(Date.now() - startedAt < 4000)
    assert.equal(store.loadSettings().slack!.credential, reference)
    assert.equal(credentials.entries.size, 1, "Invalid clipboard data modified the vault")
    if (mode === "hang") {
      const pid = Number(readFileSync(pidFile, "utf8"))
      const deadline = Date.now() + 1000
      while (isProcessAlive(pid) && Date.now() < deadline) await Bun.sleep(20)
      assert.equal(isProcessAlive(pid), false, "Timed-out clipboard helper was left running")
    }
  }
  process.env.PATH = empty
  await assert.rejects(
    clipboard.read(),
    (error) => error instanceof ClipboardReadError && error.code === "UNAVAILABLE",
  )
  console.log(
    "Clipboard passed: OS helper boundary, clipboard-only registration, bounded size/time, unavailable helper, no secret output, no vault mutation on failure",
  )
} finally {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  rmSync(workspace, { recursive: true, force: true })
}
