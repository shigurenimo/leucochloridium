import assert from "node:assert/strict"
import { createServer, type Socket } from "node:net"
import { createHash } from "node:crypto"
import { LeucoFlumeSlackEventSource } from "@/connectors/slack/leuco-flume-slack-event-source"

const localUrl = process.argv[2]
if (localUrl !== undefined) {
  assert.match(localUrl, /^ws:\/\/127\.0\.0\.1:\d+$/)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      assert.equal(url, "https://slack.com/api/apps.connections.open")
      return Response.json({ ok: true, url: localUrl })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const actions: string[] = []
  const pendingLog = { started: false }
  const source = new LeucoFlumeSlackEventSource({
    appToken: "xapp-synthetic-no-network",
    botToken: "xoxb-synthetic-no-network",
    startTimeoutMs: 3000,
  })
  const started = source.start({
    onEvent: async () => {},
    onLog: (log) => {
      actions.push(log.action)
      if (process.argv[3] === "stderr-closed") throw new Error("injected log consumer failure")
      if (process.argv[3] === "log-stall" && !pendingLog.started) {
        pendingLog.started = true
        return new Promise<void>(() => {})
      }
    },
  })
  if (process.argv[3] === "handshake") {
    const outcome = started.then(
      () => null,
      (error: unknown) => error,
    )
    await Bun.sleep(100)
    await source.stop()
    assert.ok((await outcome) instanceof Error)
  } else {
    await started
    assert.equal(source.status(), "connected")
    if (process.argv[3] === "log-stall") {
      const until = performance.now() + 2500
      while (source.getLogHealth().healthy && performance.now() < until) await Bun.sleep(20)
      assert.equal(source.getLogHealth().healthy, false)
      assert.ok(
        source
          .getLogHealth()
          .lastFailure?.causes.some((cause) =>
            cause.message.includes("Slack log delivery timed out"),
          ),
      )
    }
    if (process.argv[3] === "stderr-closed") {
      const until = performance.now() + 2500
      while (
        !source.getLogHealth().lastFailure?.causes.some((cause) => cause.code === "EPIPE") &&
        performance.now() < until
      )
        await Bun.sleep(20)
      assert.equal(source.getLogHealth().healthy, false)
      assert.ok(source.getLogHealth().lastFailure?.causes.some((cause) => cause.code === "EPIPE"))
    }
    await source.stop()
  }
  assert.equal(source.status(), "disconnected")
  console.log(JSON.stringify({ stopped: true, forced: actions.includes("socket.close.forced") }))
} else {
  for (const mode of ["graceful", "stalled", "handshake", "log-stall", "stderr-closed"]) {
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      const handshake = { bytes: "", complete: false }
      socket.on("error", () => {})
      socket.on("close", () => sockets.delete(socket))
      socket.on("data", (bytes) => {
        if (handshake.complete) {
          if (!["stalled", "handshake"].includes(mode)) socket.end(Buffer.from([0x88, 0]))
          return
        }
        handshake.bytes += bytes.toString()
        if (!handshake.bytes.includes("\r\n\r\n")) return
        const key = handshake.bytes.match(/Sec-WebSocket-Key: (.+)\r\n/i)?.[1]
        assert.ok(key)
        const accept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64")
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        )
        const hello = Buffer.from(JSON.stringify({ type: "hello" }))
        if (mode !== "handshake")
          socket.write(Buffer.concat([Buffer.from([0x81, hello.length]), hello]))
        handshake.complete = true
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    assert.ok(address !== null && typeof address !== "string")
    const child = Bun.spawn(
      [process.execPath, import.meta.path, `ws://127.0.0.1:${address.port}`, mode],
      { stdout: "pipe", stderr: "pipe" },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), 6000)
    const output = new Response(child.stdout).text()
    if (mode === "stderr-closed") await child.stderr.cancel()
    const errors =
      mode === "stderr-closed" ? Promise.resolve("") : new Response(child.stderr).text()
    try {
      assert.equal(await child.exited, 0, `${mode}: ${await errors}`)
      assert.deepEqual(JSON.parse(await output), {
        stopped: true,
        forced: ["stalled", "handshake"].includes(mode),
      })
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  console.log(
    "Slack sockets passed: real Flume/Bun graceful/stalled close, stalled log consumer, real stderr EPIPE and bounded process exit; loopback only",
  )
}
