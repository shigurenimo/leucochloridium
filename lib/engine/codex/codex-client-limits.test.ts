import { beforeEach, expect, it, vi } from "vitest"
import { LeucoCodexClient } from "@/engine/codex/codex-client"
import { MAX_TIMER_DELAY_MS } from "@/timer-limits"

const boundary = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: boundary.spawn }))
beforeEach(() => {
  boundary.spawn.mockReset().mockImplementation(() => {
    throw new Error("unexpected child spawn")
  })
})

it.each([
  { options: { protocolMaxFrameChars: 63 }, name: "maxFrameChars" },
  { options: { protocolMaxFrameChars: Infinity }, name: "maxFrameChars" },
  { options: { protocolLogPreviewChars: 0 }, name: "logPreviewChars" },
  { options: { protocolLogPreviewChars: NaN }, name: "logPreviewChars" },
  { options: { threadRequestTimeoutMs: 0 }, name: "threadRequestTimeoutMs" },
  { options: { threadRequestTimeoutMs: MAX_TIMER_DELAY_MS + 1 }, name: "threadRequestTimeoutMs" },
  { options: { threadRequestTimeoutMs: NaN }, name: "threadRequestTimeoutMs" },
  { options: { commandOutputLimitChars: -1 }, name: "commandOutputLimitChars" },
  { options: { commandOutputLimitChars: Infinity }, name: "commandOutputLimitChars" },
  { options: { commandOutputLimitChars: NaN }, name: "commandOutputLimitChars" },
])("rejects invalid $name before spawning a child", async (probe) => {
  const failure = await Promise.resolve()
    .then(() => new LeucoCodexClient(probe.options).start())
    .catch((error: unknown) => error)
  expect(String(failure)).toContain(probe.name)
  expect(boundary.spawn).not.toHaveBeenCalled()
})

it("accepts zero command output and valid protocol and timer boundaries without starting", () => {
  const client = new LeucoCodexClient({
    commandOutputLimitChars: 0,
    threadRequestTimeoutMs: MAX_TIMER_DELAY_MS,
    protocolMaxFrameChars: 64,
    protocolLogPreviewChars: 64,
  })
  expect(client.getStatus()).toMatchObject({ pid: null, ready: false })
  expect(boundary.spawn).not.toHaveBeenCalled()
})
