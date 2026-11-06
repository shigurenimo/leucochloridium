import { expect, it } from "vitest"
import type { ChatProvider } from "@/cli/chat-providers"
import { parseArguments } from "@/cli/parse-arguments"
import { validateDaemonCommand } from "@/cli/validate-daemon-command"

const slackCall = ["slack", "call", "auth.test", "--body", "{}"]
const discordCall = ["discord", "call", "GET", "/users/@me"]

it.each<[ChatProvider, string[]]>([
  ["slack", slackCall],
  ["slack", ["slack", "download-file", "--file", "F1", "--out", "/tmp/out"]],
  ["discord", discordCall],
])("accepts a %s daemon command %j", (provider, args) => {
  expect(() => validateDaemonCommand(parseArguments(args), provider)).not.toThrow()
})

it.each<[ChatProvider, string[], string]>([
  ["slack", [...slackCall, "--help"], "Slack execution does not accept --help"],
  ["discord", [...discordCall, "--help"], "Discord execution does not accept --help"],
  ["slack", ["slack", "logout"], "Unsupported Slack operation"],
  ["discord", ["discord", "logout"], "Unsupported Discord operation"],
  ["slack", discordCall, "Unsupported Slack operation"],
  ["discord", slackCall, "Unsupported Discord operation"],
])("rejects a %s command %j before execution", (provider, args, message) => {
  expect(() => validateDaemonCommand(parseArguments(args), provider)).toThrow(
    expect.objectContaining({
      code: "USAGE",
      message: expect.stringContaining(message),
      details: { phase: "validation", executionStarted: false },
    }),
  )
})

it.each<[ChatProvider, string[]]>([
  ["slack", [...slackCall, "--limit", "5"]],
  ["discord", [...discordCall, "--limit", "5"]],
])("marks %s catalog validation failures as not started %j", (provider, args) => {
  expect(() => validateDaemonCommand(parseArguments(args), provider)).toThrow(
    expect.objectContaining({
      code: "USAGE",
      message: expect.stringContaining("--limit is not supported"),
      details: { phase: "validation", executionStarted: false, validation: null },
      cause: expect.objectContaining({ code: "USAGE" }),
    }),
  )
})
