import assert from "node:assert/strict"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { runDaemon } from "@/daemon/run-daemon"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"

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
const cancellations = { received: 0 }
const envelopeCalls = { count: 0 }
const downloadEntered = Promise.withResolvers<void>()
LeucoFetchSlackWebClient.prototype.apiCall = async (method, body) => {
  if (method === "control.envelope") {
    const client = new LeucoFetchSlackWebClient({
      botToken,
      fetchFn: async () => {
        envelopeCalls.count += 1
        return Response.json(body.response)
      },
    })
    return originalApiCall.call(client, "chat.postMessage", {})
  }
  if (method === "control.echo" || method === "control.bounded") {
    const lease = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"))
    throw new Error(
      method === "control.bounded"
        ? `${"b".repeat(3988)}${lease.token}`
        : `synthetic protected controller ${lease.token}`,
    )
  }
  return method === "files.info"
    ? {
        ok: true,
        file: {
          url_private_download:
            body.file === "Fcancel"
              ? "https://files.slack.com/cancelled"
              : "https://files.slack.com/synthetic",
        },
      }
    : { ok: true, debug: botToken }
}
LeucoFetchSlackWebClient.prototype.filesUpload = async (file) => {
  uploaded.push(new TextDecoder().decode(file.content))
  return { fileId: "F-synthetic" }
}
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "https://files.slack.com/cancelled") {
      downloadEntered.resolve()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            cancellations.received += 1
            reject(init.signal?.reason)
          },
          { once: true },
        )
      })
    }
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
  for (const response of [
    null,
    [],
    "unexpected body",
    1,
    {},
    { ok: "true" },
    { ok: null },
    { ok: false, error: "missing_scope" },
  ]) {
    const previousCalls = envelopeCalls.count
    const rejected = JSON.parse(
      await cli(
        ["slack", "call", "control.envelope", "--body", JSON.stringify({ response })],
        false,
      ),
    )
    assert.equal(rejected.error.code, "OPERATION_FAILED")
    assert.equal(rejected.error.mutationMayHaveOccurred, true)
    assert.match(rejected.error.message, /slack chat.postMessage:/)
    assert.equal(envelopeCalls.count, previousCalls + 1, "Rejected Slack write was retried")
    if (
      typeof response === "object" &&
      response !== null &&
      !Array.isArray(response) &&
      !("ok" in response)
    ) {
      const history = await cli(["events", "--request", rejected.requestId])
      assert.match(history, /Slack operation failed/)
      assert.match(history, /missing a boolean ok flag/)
    }
  }
  const lease = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"))
  const echoed = await cli(["slack", "call", "control.echo", "--body", "{}"], false)
  assert.ok(!echoed.includes(lease.token), "Control token leaked to CLI diagnostics")
  const protectedHistory = await cli(["events", "--request", JSON.parse(echoed).requestId])
  assert.ok(!protectedHistory.includes(lease.token), "Control token persisted in event history")
  assert.match(protectedHistory, /synthetic protected controller \[redacted\]/)
  const bounded = await cli(["slack", "call", "control.bounded", "--body", "{}"], false)
  const boundedHistory = await cli(["events", "--request", JSON.parse(bounded).requestId])
  assert.ok(
    !bounded.includes(lease.token.slice(0, 12)),
    "Control token fragment leaked to CLI diagnostics",
  )
  assert.ok(
    !boundedHistory.includes(lease.token.slice(0, 12)),
    "Control token fragment persisted in event history",
  )
  assert.match(boundedHistory, /\[redacted\]/)
  writeFileSync(join(clientDirectory, "source.txt"), "caller supplied bytes")
  await cli(["slack", "upload-file", "--channel", "C123", "--file", "source.txt"])
  assert.deepEqual(uploaded, ["caller supplied bytes"])
  await cli(["slack", "download-file", "--file", "F123", "--out", "result.txt"])
  assert.equal(
    readFileSync(join(clientDirectory, "result.txt"), "utf8"),
    "downloaded synthetic file",
  )
  assert.deepEqual(credentials.reads, [reference])
  const cancellingDownload = cli(
    [
      "slack",
      "download-file",
      "--file",
      "Fcancel",
      "--out",
      "cancelled.txt",
      "--timeout-ms",
      "1000",
    ],
    false,
  )
  await awaitBoundedCleanup(downloadEntered.promise, "Synthetic Slack download entry", 3000)
  const inFlightStatus = JSON.parse(await cli(["status"]))
  assert.equal(inFlightStatus.runtime.active, null)
  assert.equal(inFlightStatus.runtime.slack.active, 1)
  assert.equal(inFlightStatus.runtime.slack.requests[0].action, "download-file")
  assert.equal(inFlightStatus.runtime.slack.requests[0].cancellationRequested, false)
  assert.ok(!JSON.stringify(inFlightStatus).includes("Fcancel"))
  const cancelled = await cancellingDownload
  assert.equal(inFlightStatus.runtime.slack.requests[0].requestId, JSON.parse(cancelled).requestId)
  assert.match(cancelled, /STATE_UNCERTAIN/)
  const cancellationDeadline = Date.now() + 2000
  while (cancellations.received === 0 && Date.now() < cancellationDeadline) await Bun.sleep(10)
  assert.equal(cancellations.received, 1, "Caller cancellation did not reach the Slack download")
  assert.equal(existsSync(join(clientDirectory, "cancelled.txt")), false)
  const cancelledHistory = await cli(["events", "--request", JSON.parse(cancelled).requestId])
  assert.match(cancelledHistory, /Slack operation cancelled/)
  assert.match(cancelledHistory, /external effects may already have been accepted/)
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
