import { describe, expect, it } from "vitest"
import { parseArguments } from "@/cli/parse-arguments"
import { validateCommand } from "@/cli/validate-command"

describe("flat CLI commands", () => {
  it.each([
    ["run", "--no-soul", "--foreground"],
    ["start", "--cwd", "/work"],
    ["ask", "two", "words", "--thread", "notes"],
    ["config", "set", "soul", "null"],
    ["session", "reset", "notes"],
    ["schedules", "list"],
    ["slack", "call", "chat.postMessage", "--body", "{}"],
  ])("accepts supported arguments %j", (...args) => {
    expect(() => validateCommand(parseArguments(args))).not.toThrow()
  })
  it.each([
    ["config"],
    ["schedules"],
    ["session"],
    ["migrate"],
    ["projects"],
    ["connectors"],
    ["boot"],
    ["stop", "--soul", "/SOUL.md"],
    ["run", "ignored"],
    ["run", "--prompt", "hello"],
    ["run", "--prompt", "hello", "--thread", "notes"],
    ["ask"],
    ["start", "--prompt", "ignored"],
    ["start", "--model", "sample-model"],
    ["run", "--prompt", "hello", "--model", "sample-model"],
    ["restart", "--model", "sample-model"],
    ["start", "--codex-bin", "/custom/codex"],
    ["run", "--prompt", "hello", "--codex-bin", "/custom/codex"],
    ["restart", "--codex-bin", "/custom/codex"],
    ["config", "set", "cwd"],
    ["run", "--soul", "/one", "--soul", "/two"],
    ["schedules", "list", "--body", "{}"],
  ])("rejects unsupported or silently ignored arguments %j", (...args) => {
    expect(() => validateCommand(parseArguments(args))).toThrow()
  })
})

it("reports the catalog conflict between --soul and --no-soul", () => {
  expect(() =>
    validateCommand(parseArguments(["run", "--foreground", "--soul=a", "--no-soul"])),
  ).toThrow(
    expect.objectContaining({
      code: "USAGE",
      details: { parameter: "soul", conflictsWith: ["no-soul"] },
    }),
  )
})

it.each(["", "   ", "\n\t", "　"])("rejects a blank prompt before dispatch: %j", (text) => {
  expect(() => validateCommand(parseArguments(["ask", text]))).toThrow()
})
it("validates all joined prompt words and preserves leading blank words", () => {
  expect(() => validateCommand(parseArguments(["ask", " ", "meaningful"]))).not.toThrow()
})

it.each(["../auth.test", "chat.postMessage?token=x", "chat/postMessage", " "])(
  "rejects an invalid Slack method before daemon dispatch: %j",
  (method) => {
    expect(() =>
      validateCommand(parseArguments(["slack", "call", method, "--body", "{}"])),
    ).toThrow()
  },
)

it.each([
  ["GET", "/users/@me"],
  ["GET", "/channels/123/messages?limit=10"],
  ["PUT", "/channels/1/messages/2/reactions/%F0%9F%91%8D/@me"],
  ["DELETE", "/channels/1/messages/2", "--body", "{}"],
])("accepts a Discord call the daemon would dispatch: %s %s", (...args) => {
  expect(() => validateCommand(parseArguments(["discord", "call", ...args]))).not.toThrow()
})

it.each([
  ["GET", "https://evil.test", "Invalid endpoint"],
  ["GET", "//evil.test", "Invalid endpoint"],
  ["GET", "/channels/1#fragment", "Invalid endpoint"],
  ["GET", "/../evil", "Invalid endpoint"],
  ["GET", "/channels/%2e%2e/evil", "traversal"],
  ["GET", "/%5cevil", "traversal"],
  ["GET", "/channels/%E0%A4", "percent-encoding"],
  ["GET", "/users/@me --body {}", "--body"],
])("rejects a Discord call before daemon dispatch: %s %s", (method, endpoint, message) => {
  const words = endpoint.split(" ")
  expect(() => validateCommand(parseArguments(["discord", "call", method, ...words]))).toThrow(
    expect.objectContaining({ code: "USAGE", message: expect.stringContaining(message) }),
  )
})
