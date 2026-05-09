import { describe, expect, it } from "vitest"
import { LeucoCodexClient } from "@/engine/codex/codex-client"

const fakeCodexRespondingWithError = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split('\\n');",
  "  buffer = lines.pop();",
  "  for (const line of lines) {",
  "    if (line.length === 0) continue;",
  "    const msg = JSON.parse(line);",
  "    if (msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'init failed' } }) + '\\n');",
  "    }",
  "  }",
  "});",
  "setInterval(() => {}, 1_000_000);",
].join("\n")

describe("LeucoCodexClient.start", () => {
  it("kills the child process when initialize rejects", async () => {
    const client = new LeucoCodexClient({
      bin: "node",
      args: ["-e", fakeCodexRespondingWithError],
    })

    await expect(client.start()).rejects.toThrow("init failed")

    // After start() rejects, the supervisor must have torn the child down so
    // a subsequent stop() is a no-op and isRunning() reports false.
    expect(client.isRunning()).toBe(false)
  })
})
