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
