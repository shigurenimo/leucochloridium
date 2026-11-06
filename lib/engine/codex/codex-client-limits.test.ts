import { beforeEach, expect, it, vi } from "vitest"
import { LeucoCodexClient } from "@/engine/codex/codex-client"

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
])("rejects invalid $name before spawning a child", async (probe) => {
  const failure = await Promise.resolve()
    .then(() => new LeucoCodexClient(probe.options).start())
    .catch((error: unknown) => error)
  expect(String(failure)).toContain(probe.name)
  expect(boundary.spawn).not.toHaveBeenCalled()
})

it("accepts the minimum protocol limits and reaches spawn", async () => {
  const failure = await new LeucoCodexClient({
    protocolMaxFrameChars: 64,
    protocolLogPreviewChars: 64,
  })
    .start()
    .catch((error: unknown) => error)
  expect(String(failure)).toContain("unexpected child spawn")
  expect(boundary.spawn).toHaveBeenCalledTimes(1)
})
