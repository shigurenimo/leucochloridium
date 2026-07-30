import { describe, expect, it, vi } from "vitest"
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

const fakeCodexAcksThenExits = [
  "let buffer = '';",
  "let initialized = false;",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split('\\n');",
  "  buffer = lines.pop();",
  "  for (const line of lines) {",
  "    if (line.length === 0) continue;",
  "    let msg;",
  "    try { msg = JSON.parse(line); } catch { continue; }",
  "    if (msg.method === 'initialize' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
  "      initialized = true;",
  "      continue;",
  "    }",
  "    if (msg.method === 'turn/start' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-x' } } }) + '\\n');",
  "      // Simulate codex crashing mid-turn before turn/completed fires.",
  "      setTimeout(() => process.exit(1), 10);",
  "      continue;",
  "    }",
  "  }",
  "});",
  "setInterval(() => {}, 1_000_000);",
].join("\n")

const fakeCodexWithCorrelatedNotifications = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split('\\n');",
  "  buffer = lines.pop();",
  "  for (const line of lines) {",
  "    if (line.length === 0) continue;",
  "    const msg = JSON.parse(line);",
  "    if (msg.method === 'initialize' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
  "      continue;",
  "    }",
  "    if (msg.method === 'turn/start' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-target' } } }) + '\\n');",
  "      setTimeout(() => {",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-other', turnId: 'turn-other', completedAtMs: Date.now(), item: { type: 'agentMessage', text: 'wrong' } } }) + '\\n');",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-other', turn: { id: 'turn-other', status: 'completed', error: null } } }) + '\\n');",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/started', params: { threadId: msg.params.threadId, turnId: 'turn-other', item: { type: 'reasoning', id: 'wrong-turn' } } }) + '\\n');",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/started', params: { threadId: msg.params.threadId, turnId: 'turn-target', item: { type: 'reasoning', id: 'right-turn' } } }) + '\\n');",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: msg.params.threadId, turnId: 'turn-target', completedAtMs: Date.now(), item: { type: 'agentMessage', text: 'right' } } }) + '\\n');",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn-target', status: 'completed', error: null } } }) + '\\n');",
  "      }, 10);",
  "    }",
  "  }",
  "});",
  "setInterval(() => {}, 1_000_000);",
].join("\n")

const fakeCodexCompletingWithStatus = (status: string): string =>
  [
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += chunk;",
    "  const lines = buffer.split('\\n');",
    "  buffer = lines.pop();",
    "  for (const line of lines) {",
    "    if (line.length === 0) continue;",
    "    const msg = JSON.parse(line);",
    "    if (msg.method === 'initialize' && msg.id != null) {",
    "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
    "      continue;",
    "    }",
    "    if (msg.method === 'turn/start' && msg.id != null) {",
    "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-status' } } }) + '\\n');",
    `      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn-status', status: ${JSON.stringify(status)}, error: null } } }) + '\\n');`,
    "    }",
    "  }",
    "});",
    "setInterval(() => {}, 1_000_000);",
  ].join("\n")

const fakeCodexWithCommentaryAndFinal = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split('\\n');",
  "  buffer = lines.pop();",
  "  for (const line of lines) {",
  "    if (line.length === 0) continue;",
  "    const msg = JSON.parse(line);",
  "    if (msg.method === 'initialize' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
  "      continue;",
  "    }",
  "    if (msg.method === 'turn/start' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-phases' } } }) + '\\n');",
  "      setTimeout(() => {",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: msg.params.threadId, turnId: 'turn-phases', item: { type: 'agentMessage', text: 'working note', phase: 'commentary' } } }) + '\\n');",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: msg.params.threadId, turnId: 'turn-phases', item: { type: 'agentMessage', text: 'visible answer', phase: 'final_answer' } } }) + '\\n');",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn-phases', status: 'completed', error: null } } }) + '\\n');",
  "      }, 10);",
  "    }",
  "  }",
  "});",
  "setInterval(() => {}, 1_000_000);",
].join("\n")

const fakeCodexWithOnlyCommentary = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split('\\n');",
  "  buffer = lines.pop();",
  "  for (const line of lines) {",
  "    if (line.length === 0) continue;",
  "    const msg = JSON.parse(line);",
  "    if (msg.method === 'initialize' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
  "      continue;",
  "    }",
  "    if (msg.method === 'turn/start' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-commentary' } } }) + '\\n');",
  "      setTimeout(() => {",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId: 'turn-commentary', itemId: 'item-commentary', delta: 'private working note' } }) + '\\n');",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: msg.params.threadId, turnId: 'turn-commentary', item: { type: 'agentMessage', text: 'private working note', phase: 'commentary' } } }) + '\\n');",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn-commentary', status: 'completed', error: null } } }) + '\\n');",
  "      }, 10);",
  "    }",
  "  }",
  "});",
  "setInterval(() => {}, 1_000_000);",
].join("\n")

const fakeCodexWithLegacyNullPhase = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split('\\n');",
  "  buffer = lines.pop();",
  "  for (const line of lines) {",
  "    if (line.length === 0) continue;",
  "    const msg = JSON.parse(line);",
  "    if (msg.method === 'initialize' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
  "      continue;",
  "    }",
  "    if (msg.method === 'turn/start' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-legacy' } } }) + '\\n');",
  "      setTimeout(() => {",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: msg.params.threadId, turnId: 'turn-legacy', item: { type: 'agentMessage', text: 'legacy answer', phase: null } } }) + '\\n');",
  "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn-legacy', status: 'completed', error: null } } }) + '\\n');",
  "      }, 10);",
  "    }",
  "  }",
  "});",
  "setInterval(() => {}, 1_000_000);",
].join("\n")

const fakeCodexIgnoringThreadRequests = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split('\\n');",
  "  buffer = lines.pop();",
  "  for (const line of lines) {",
  "    if (line.length === 0) continue;",
  "    const msg = JSON.parse(line);",
  "    if (msg.method === 'initialize' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
  "    }",
  "  }",
  "});",
  "setInterval(() => {}, 1_000_000);",
].join("\n")

const fakeCodexClosingStdin = [
  "const fs = require('node:fs');",
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split('\\n');",
  "  buffer = lines.pop();",
  "  for (const line of lines) {",
  "    if (line.length === 0) continue;",
  "    const msg = JSON.parse(line);",
  "    if (msg.method === 'initialize' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
  "      setTimeout(() => fs.closeSync(0), 10);",
  "    }",
  "  }",
  "});",
  "setInterval(() => {}, 1_000_000);",
].join("\n")

const fakeCodexEmittingOversizedFrame = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split('\\n');",
  "  buffer = lines.pop();",
  "  for (const line of lines) {",
  "    if (line.length === 0) continue;",
  "    const msg = JSON.parse(line);",
  "    if (msg.method === 'initialize' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
  "      continue;",
  "    }",
  "    if (msg.method === 'turn/start' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-large' } } }) + '\\n');",
  "      process.stdout.write('x'.repeat(1_000));",
  "    }",
  "  }",
  "});",
  "setInterval(() => {}, 1_000_000);",
].join("\n")

const fakeCodexAcksThenStreamsLargeCommandOutput = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split('\\n');",
  "  buffer = lines.pop();",
  "  for (const line of lines) {",
  "    if (line.length === 0) continue;",
  "    let msg;",
  "    try { msg = JSON.parse(line); } catch { continue; }",
  "    if (msg.method === 'initialize' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
  "      continue;",
  "    }",
  "    if (msg.method === 'turn/start' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-big' } } }) + '\\n');",
  "      process.stdout.write(JSON.stringify({",
  "        jsonrpc: '2.0',",
  "        method: 'item/commandExecution/outputDelta',",
  "        params: { threadId: msg.params.threadId, turnId: 'turn-big', itemId: 'call_big', delta: 'abcdef' },",
  "      }) + '\\n');",
  "      continue;",
  "    }",
  "  }",
  "});",
  "setInterval(() => {}, 1_000_000);",
].join("\n")

const fakeCodexStreamsConcurrentTurns = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split('\\n');",
  "  buffer = lines.pop();",
  "  for (const line of lines) {",
  "    if (line.length === 0) continue;",
  "    let msg;",
  "    try { msg = JSON.parse(line); } catch { continue; }",
  "    if (msg.method === 'initialize' && msg.id != null) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
  "      continue;",
  "    }",
  "    if (msg.method === 'turn/start' && msg.id != null) {",
  "      const threadId = msg.params.threadId;",
  "      const turnId = `turn-${threadId}`;",
  "      const text = msg.params.input[0].text;",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } }) + '\\n');",
  "      const delay = threadId === 'thread-a' ? 20 : 5;",
  "      setTimeout(() => {",
  "        notify('item/agentMessage/delta', { threadId, turnId, itemId: `item-${threadId}`, delta: `delta:${text}` });",
  "        notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', text: `reply:${text}` } });",
  "        notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });",
  "      }, delay);",
  "      continue;",
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

describe("LeucoCodexClient.runTextTurn", () => {
  it("rejects an in-flight turn when the codex child exits mid-turn", async () => {
    const client = new LeucoCodexClient({
      bin: "node",
      args: ["-e", fakeCodexAcksThenExits],
    })

    await client.start()

    const turn = client.runTextTurn("thread-x", "hello")
    const result = await turn

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toMatch(/codex app-server exited/)
    }
    expect(client.isRunning()).toBe(false)
  }, 5000)

  it("aborts and stops the child when command output exceeds the turn budget", async () => {
    const client = new LeucoCodexClient({
      bin: "node",
      args: ["-e", fakeCodexAcksThenStreamsLargeCommandOutput],
      commandOutputLimitChars: 5,
    })

    await client.start()

    const result = await client.runTextTurn("thread-x", "hello")

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toBe("codex command output exceeded 5 chars from call_big")
    }
    for (let i = 0; i < 20 && client.isRunning(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(client.isRunning()).toBe(false)
  }, 5000)

  it("routes interleaved notifications to concurrent turns by thread id", async () => {
    const client = new LeucoCodexClient({
      bin: "node",
      args: ["-e", fakeCodexStreamsConcurrentTurns],
    })

    await client.start()

    const first = client.runTextTurn("thread-a", "first")
    const second = client.runTextTurn("thread-b", "second")

    await expect(Promise.all([first, second])).resolves.toEqual(["reply:first", "reply:second"])
    await client.stop()
  }, 5000)

  it("ignores notifications for other threads and turns", async () => {
    const onActivity = vi.fn()
    const client = new LeucoCodexClient({
      bin: "node",
      args: ["-e", fakeCodexWithCorrelatedNotifications],
    })
    await client.start()

    await expect(client.runTextTurn("thread-target", "hello", { onActivity })).resolves.toBe(
      "right",
    )

    // turn/start response + one generic item notification + item/completed +
    // turn/completed. Other thread and other turn notifications do not count.
    expect(onActivity).toHaveBeenCalledTimes(4)
    await client.stop()
  }, 5000)

  it("returns final-answer text without concatenating commentary", async () => {
    const client = new LeucoCodexClient({
      bin: "node",
      args: ["-e", fakeCodexWithCommentaryAndFinal],
    })
    await client.start()

    await expect(client.runTextTurn("thread-target", "hello")).resolves.toBe("visible answer")

    await client.stop()
  }, 5000)

  it("does not expose commentary when a completed turn has no final answer", async () => {
    const client = new LeucoCodexClient({
      bin: "node",
      args: ["-e", fakeCodexWithOnlyCommentary],
    })
    await client.start()

    await expect(client.runTextTurn("thread-target", "hello")).resolves.toBe("")

    await client.stop()
  }, 5000)

  it("accepts null phase from legacy agent-message items", async () => {
    const client = new LeucoCodexClient({
      bin: "node",
      args: ["-e", fakeCodexWithLegacyNullPhase],
    })
    await client.start()

    await expect(client.runTextTurn("thread-target", "hello")).resolves.toBe("legacy answer")

    await client.stop()
  }, 5000)

  it.each(["interrupted", "cancelled"])(
    "returns an Error when a matching turn completes as %s",
    async (status) => {
      const client = new LeucoCodexClient({
        bin: "node",
        args: ["-e", fakeCodexCompletingWithStatus(status)],
      })
      await client.start()

      const result = await client.runTextTurn("thread-target", "hello")

      expect(result).toBeInstanceOf(Error)
      if (result instanceof Error) expect(result.message).toContain(status)
      await client.stop()
    },
    5000,
  )

  it("fails promptly when the child closes its stdin but remains alive", async () => {
    const logs: string[] = []
    const client = new LeucoCodexClient({
      bin: "node",
      args: ["-e", fakeCodexClosingStdin],
      onLog: (line) => logs.push(line),
    })
    await client.start()
    await new Promise((resolve) => setTimeout(resolve, 30))

    const result = await client.runTextTurn("thread-target", "hello")

    expect(result).toBeInstanceOf(Error)
    expect(client.isRunning()).toBe(false)
    expect(logs.some((line) => line.includes("[codex stdin]"))).toBe(true)
    await client.stop()
  }, 5000)
})

describe("LeucoCodexClient thread request timeout", () => {
  it.each(["start", "resume"])(
    "discards the child after thread/%s times out",
    async (method) => {
      const client = new LeucoCodexClient({
        bin: "node",
        args: ["-e", fakeCodexIgnoringThreadRequests],
        threadRequestTimeoutMs: 20,
      })
      await client.start()

      const result =
        method === "start"
          ? await client.startThread({ cwd: "/tmp" })
          : await client.resumeThread({ threadId: "missing", cwd: "/tmp" })

      expect(result).toBeInstanceOf(Error)
      if (result instanceof Error) expect(result.message).toContain("timed out")
      expect(client.isRunning()).toBe(false)

      await client.start()
      expect(client.isRunning()).toBe(true)
      await client.stop()
    },
    5000,
  )
})

describe("LeucoCodexClient spawn failure", () => {
  it("reports isRunning=false when the binary cannot be spawned", async () => {
    const client = new LeucoCodexClient({
      bin: "leuco-test-binary-that-does-not-exist",
      args: [],
    })

    await expect(client.start()).rejects.toThrow()

    // Spawn failure emits `error` without `exit`; the supervisor must still
    // clear the dead child or every later start() no-ops against a ghost and
    // the runtime never respawns.
    expect(client.isRunning()).toBe(false)
  }, 5000)

  it("terminates the transport when stdout contains an oversized frame", async () => {
    const logs: string[] = []
    const client = new LeucoCodexClient({
      bin: "node",
      args: ["-e", fakeCodexEmittingOversizedFrame],
      onLog: (line) => logs.push(line),
      protocolMaxFrameChars: 256,
    })
    await client.start()

    const result = await client.runTextTurn("thread-target", "hello")

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toContain("codex protocol frame exceeded 256 characters")
    }
    await client.stop()
    expect(client.isRunning()).toBe(false)
    expect(logs.join("\n")).not.toContain("x".repeat(100))
  }, 5000)
})
