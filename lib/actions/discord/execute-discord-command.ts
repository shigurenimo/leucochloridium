import { z } from "zod"
import type { CliArguments } from "@/cli/parse-arguments"
import { discordCall } from "@/actions/discord/discord-call"

type Props = { parsed: CliArguments; botToken: string }

export async function executeDiscordCommand(props: Props): Promise<unknown> {
  const method = props.parsed.words[2]
  const endpoint = props.parsed.words[3]
  if (props.parsed.words[1] !== "call" || !method || !endpoint)
    throw new Error("Usage: leuco discord call <method> <endpoint> [--body <json>]")
  const raw = props.parsed.flags.body
  const body =
    typeof raw === "string" ? z.record(z.string(), z.unknown()).parse(JSON.parse(raw)) : undefined
  if (method === "GET" && body !== undefined)
    throw new Error("GET requests use query parameters in the endpoint, not --body")
  return discordCall({ botToken: props.botToken, method, endpoint, body })
}
