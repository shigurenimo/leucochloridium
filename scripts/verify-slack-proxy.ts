import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { runDaemon } from "@/daemon/run-daemon"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"

if (process.platform === "win32")
  throw new Error(
    "Native desktop-helper fixtures are not yet validated on Windows; refusing to read the user's real clipboard.",
  )

const repository = resolve(import.meta.dir, "..")
const workspace = realpathSync(mkdtempSync("/tmp/leuco-proxy-"))
const home = join(workspace, "state")
const clipboardHelpers = join(workspace, "clipboard-helpers")
mkdirSync(clipboardHelpers)
for (const name of ["pbpaste", "wl-paste", "xclip", "xsel"])
  writeFileSync(join(clipboardHelpers, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
const clipboardPath = `${clipboardHelpers}:${process.env.PATH ?? ""}`

const clientDirectory = join(workspace, "client")
mkdirSync(clientDirectory)
const store = new NodeLeucoStore(home)
const credentials = new MemoryCredentialStore()
const reference = "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d"
const botToken = "xoxb-synthetic-secret"
const appToken = "xapp-synthetic-secret"
await credentials.set(reference, JSON.stringify({ botToken, appToken }))
store.updateSettings((settings) => ({
  ...settings,
  slack: { credential: reference, ackMode: "off" },
}))
const originalApiCall = LeucoFetchSlackWebClient.prototype.apiCall
const originalUpload = LeucoFetchSlackWebClient.prototype.filesUpload
const originalFetch = globalThis.fetch
const uploaded: string[] = []
LeucoFetchSlackWebClient.prototype.apiCall = async (method) =>
  method === "files.info"
    ? { ok: true, file: { url_private_download: "https://files.slack.com/synthetic" } }
    : { ok: true, debug: botToken }
LeucoFetchSlackWebClient.prototype.filesUpload = async (file) => {
  uploaded.push(new TextDecoder().decode(file.content))
  return { fileId: "F-synthetic" }
}
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "https://files.slack.com/synthetic") {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${botToken}`)
      return new Response("downloaded synthetic file")
    }
    return originalFetch(input, init)
  },
  { preconnect: originalFetch.preconnect },
)
async function cli(args: string[], success = true): Promise<string> {
  const child = Bun.spawn([process.execPath, join(repository, "lib/index.ts"), ...args, "--json"], {
    cwd: clientDirectory,
    env: { ...process.env, LEUCO_HOME: home, PATH: clipboardPath },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const output =
      (await new Response(child.stdout).text()) + (await new Response(child.stderr).text())
    assert.equal((await child.exited) === 0, success, `${args.join(" ")}: ${output}`)
    assert.ok(
      !output.includes(botToken) && !output.includes(appToken),
      "Credential leaked to CLI output",
    )
    return success ? JSON.stringify(JSON.parse(output).data) : output
  } finally {
    clearTimeout(timer)
  }
}
const running = runDaemon({
  home,
  store,
  credentials,
  codex: new MemoryCodexClient(),
  connections: [],
})
try {
  const deadline = Date.now() + 5000
  const readiness = { ready: false }
  while (!readiness.ready && Date.now() < deadline) {
    try {
      readiness.ready = JSON.parse(await cli(["status"])).ready === true
    } catch {}
    if (!readiness.ready) await Bun.sleep(20)
  }
  assert.equal(readiness.ready, true)
  assert.equal(JSON.parse(await cli(["slack", "call", "auth.test", "--body", "{}"])).ok, true)
  writeFileSync(join(clientDirectory, "source.txt"), "caller supplied bytes")
  await cli(["slack", "upload-file", "--channel", "C123", "--file", "source.txt"])
  assert.deepEqual(uploaded, ["caller supplied bytes"])
  await cli(["slack", "download-file", "--file", "F123", "--out", "result.txt"])
  assert.equal(
    readFileSync(join(clientDirectory, "result.txt"), "utf8"),
    "downloaded synthetic file",
  )
  assert.deepEqual(credentials.reads, [reference])
  assert.ok(!readFileSync(join(home, "settings.json"), "utf8").includes("synthetic-secret"))
  await cli(["slack", "login", "bot"], false)
  await cli(["slack", "logout"], false)
  await cli(["stop"])
  await running
  assert.match(await cli(["slack", "login", "bot"], false), /clipboard/i)
  await cli(["slack", "call", "auth.test", "--body", "{}"], false)
  console.log(
    "Slack proxy integration passed: startup-only credentials, caller-side file IO, no token output",
  )
} finally {
  await cli(["stop"]).catch(() => {})
  await running.catch(() => {})
  globalThis.fetch = originalFetch
  LeucoFetchSlackWebClient.prototype.apiCall = originalApiCall
  LeucoFetchSlackWebClient.prototype.filesUpload = originalUpload
  rmSync(workspace, { recursive: true, force: true })
}
