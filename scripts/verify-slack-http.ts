import assert from "node:assert/strict"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { errorDetails } from "@/error-details"

const mode = process.argv[2]
if (mode === "redirect") {
  const state = { requests: 0, forwarded: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      state.requests += 1
      if (new URL(request.url).pathname === "/start")
        return Response.redirect(new URL("/forwarded", request.url).href, 307)
      state.forwarded += 1
      return Response.json({ ok: true })
    },
  })
  try {
    const client = new LeucoFetchSlackWebClient({
      botToken: "synthetic-loopback-only",
      fetchFn: (_input, init) => fetch(new URL("/start", server.url), init),
    })
    for (const method of ["chat.postMessage", "files.completeUploadExternal"]) {
      state.requests = 0
      const failure = await client
        .apiCall(method, { text: "synthetic" })
        .catch((error: unknown) => error)
      assert.ok(failure instanceof Error, "Redirected API operation unexpectedly succeeded")
      assert.equal(state.requests, 1, "API request was replayed through a redirect")
      assert.equal(state.forwarded, 0)
    }
  } finally {
    await server.stop(true)
  }
  process.stdout.write(JSON.stringify({ mode, bounded: true }))
  process.exit(0)
}

if (mode !== undefined) {
  const client = new LeucoFetchSlackWebClient({
    botToken: "synthetic-no-network-token",
    requestTimeoutMs: 20,
    fetchFn: async () => {
      if (mode === "identity") return Response.json({ ok: true, user_id: " \t" })
      if (mode === "fetch") return new Promise<Response>(() => {})
      const body = new ReadableStream<Uint8Array>(
        {
          pull(stream) {
            if (mode === "empty") stream.enqueue(new Uint8Array())
            if (mode === "small") stream.enqueue(new Uint8Array([32]))
          },
          cancel() {
            if (mode === "cleanup") return new Promise<void>(() => {})
          },
        },
        { highWaterMark: 0 },
      )
      return new Response(body, { status: mode === "cleanup" ? 503 : 200 })
    },
  })
  const failure = await client.authTest().then(
    () => null,
    (error: unknown) => error,
  )
  const causes = errorDetails(failure)
  if (mode === "identity") {
    assert.ok(causes.some((cause) => cause.message.includes("invalid identity response")))
    assert.ok(causes.some((cause) => cause.name === "ZodError"))
  } else
    assert.ok(
      causes.some((cause) => cause.message.includes("timed out")),
      JSON.stringify(causes),
    )
  if (mode === "cleanup") assert.ok(causes.some((cause) => cause.message.includes("http 503")))
  process.stdout.write(JSON.stringify({ mode, bounded: true }))
  process.exit(0)
}

for (const scenario of ["fetch", "read", "empty", "small", "cleanup", "identity", "redirect"]) {
  const child = Bun.spawn([process.execPath, import.meta.path, scenario], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
  try {
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    assert.equal(await child.exited, 0, `${scenario}: ${await errors}`)
    assert.deepEqual(JSON.parse(await output), { mode: scenario, bounded: true })
  } finally {
    clearTimeout(timer)
  }
}
console.log(
  "Slack HTTP passed: identity validation, bounded fetch, body reads, empty chunks, cleanup and redirect refusal; loopback only",
)
