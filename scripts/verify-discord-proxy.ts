import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { runDaemon } from "@/daemon/run-daemon"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { DiscordConnector } from "@/connectors/discord/discord-connector"
import {
  DiscordEventSource,
  type DiscordSourceHandlers,
} from "@/connectors/discord/discord-event-source"
import { discordReceptionSchema } from "@/config/config-schema"
import { discordCall } from "@/actions/discord/discord-call"

class LocalGateway extends DiscordEventSource {
  handlers: DiscordSourceHandlers | null = null
  async start(handlers: DiscordSourceHandlers) {
    this.handlers = handlers
  }
  async stop() {
    this.handlers = null
  }
  status() {
    return this.handlers === null ? "disconnected" : "connected"
  }
  async message(id: string, overrides: Record<string, unknown> = {}) {
    await this.handlers?.onEvent({
      type: "MESSAGE_CREATE",
      receivedAt: Date.now(),
      data: {
        id,
        channel_id: "123",
        guild_id: "456",
        author: { id: "user" },
        content: "hello",
        ...overrides,
      },
    })
  }
}

const repository = resolve(import.meta.dir, "..")
const workspace = realpathSync(mkdtempSync(join(tmpdir(), "leuco-discord-")))
const home = join(workspace, "state")
const store = new NodeLeucoStore(home)
const credentials = new MemoryCredentialStore()
const reference = "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d"
const botToken = "synthetic-discord-token.secret.signature"
await credentials.set(reference, JSON.stringify({ botToken }))
store.updateSettings((settings) => ({
  ...settings,
  discord: { credential: reference, messageContent: true },
}))
const originalFetch = globalThis.fetch
const requests: Array<{ method: string; path: string; body: unknown }> = []
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.origin !== "https://discord.com") return originalFetch(input, init)
    assert.equal(new Headers(init?.headers).get("authorization"), `Bot ${botToken}`)
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    })
    if (url.pathname === "/api/v10/users/@me")
      return Response.json({ id: "bot", bot: true, debug: botToken })
    return Response.json({ id: "789", debug: botToken })
  },
  { preconnect: originalFetch.preconnect },
)
const gateway = new LocalGateway()
const codex = new MemoryCodexClient()
const connector = new DiscordConnector({
  source: gateway,
  api: (method, endpoint, body) => discordCall({ botToken, method, endpoint, body }),
  reception: discordReceptionSchema.parse({}),
})
async function cli(args: string[], success = true): Promise<unknown> {
  const child = Bun.spawn([process.execPath, join(repository, "lib/index.ts"), ...args, "--json"], {
    env: { ...process.env, LEUCO_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const output =
      (await new Response(child.stdout).text()) + (await new Response(child.stderr).text())
    assert.equal((await child.exited) === 0, success, output)
    assert.ok(!output.includes(botToken), "Discord credential leaked to CLI")
    return JSON.parse(output).data
  } finally {
    clearTimeout(timer)
  }
}
const running = runDaemon({ home, credentials, codex, connections: [connector] })
try {
  const deadline = Date.now() + 5000
  const readiness = { ready: false }
  while (!readiness.ready && Date.now() < deadline) {
    const status = await cli(["status"])
    readiness.ready =
      typeof status === "object" && status !== null && "ready" in status && status.ready === true
    if (!readiness.ready) await Bun.sleep(20)
  }
  assert.equal(readiness.ready, true)
  await gateway.message("1")
  assert.equal(codex.turns.length, 0, "Unaddressed message started Codex")
  await gateway.message("2", { mentions: [{ id: "bot" }] })
  assert.equal(codex.turns.length, 1)
  await gateway.message("3", { guild_id: undefined })
  assert.equal(codex.turns.length, 2)
  await cli([
    "discord",
    "call",
    "POST",
    "/channels/123/messages",
    "--body",
    '{"content":"explicit reply","allowed_mentions":{"parse":[]}}',
  ])
  assert.ok(
    requests.some(
      (request) => request.method === "POST" && request.path === "/api/v10/channels/123/messages",
    ),
  )
  await cli(["discord", "call", "GET", "/users/@me"])
  await cli(["discord", "call", "GET", "https://evil.invalid"], false)
  await cli(["discord", "login"], false)
  await cli(["discord", "logout"], false)
  assert.deepEqual(credentials.reads, [reference])
  assert.ok(!readFileSync(join(home, "settings.json"), "utf8").includes(botToken))
  assert.ok(!JSON.stringify([codex.starts, codex.turns]).includes(botToken))
  await cli(["stop"])
  await running
  await cli(["discord", "call", "GET", "/users/@me"], false)
  console.log(
    "Discord integration passed: reception gates, Gateway-to-Codex turns, explicit CLI REST, startup-only credentials and redacted output",
  )
} finally {
  await cli(["stop"]).catch(() => {})
  await running.catch(() => {})
  globalThis.fetch = originalFetch
  rmSync(workspace, { recursive: true, force: true })
}
