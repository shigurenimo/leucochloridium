import { describe, expect, it } from "vitest"
import { parseArguments } from "@/cli/parse-arguments"
import { validateCommand } from "@/cli/validate-command"

describe("flat CLI commands", () => {
  it.each([
    ["run", "--no-soul"],
    ["start", "--cwd", "/work"],
    ["ask", "two", "words", "--thread", "notes"],
    ["config", "set", "soul", "null"],
    ["session", "reset", "notes"],
    ["schedules"],
    ["slack", "call", "chat.postMessage", "--body", "{}"],
  ])("accepts supported arguments %j", (...args) => {
    expect(() => validateCommand(parseArguments(args))).not.toThrow()
  })
  it.each([
    ["migrate"],
    ["projects"],
    ["connectors"],
    ["boot"],
    ["stop", "--soul", "/SOUL.md"],
    ["run", "ignored"],
    ["ask"],
    ["start", "--prompt", "ignored"],
    ["config", "set", "cwd"],
    ["run", "--soul", "/one", "--soul", "/two"],
    ["schedules", "list", "--body", "{}"],
  ])("rejects unsupported or silently ignored arguments %j", (...args) => {
    expect(() => validateCommand(parseArguments(args))).toThrow()
  })
})
