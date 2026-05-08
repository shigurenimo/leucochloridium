import { WebClient } from "@slack/web-api"
import type { Agent, Project, SlackChannel } from "@/config/config-schema"

type Props = {
  botToken: string
  method: string
  body?: Record<string, unknown>
}

/**
 * Generic Slack Web API forwarder. Mirrors `@slack/web-api`'s `apiCall`:
 * pass any method name (e.g. `chat.postMessage`, `conversations.replies`,
 * `reactions.add`, `files.upload`) plus a body object, get the parsed JSON
 * back. Used by the MCP `slack_call` tool and the `leuco slack call` CLI so
 * agents can reach the full Slack surface without leuco having to enumerate
 * every method individually.
 */
export const slackCall = async (props: Props): Promise<unknown | Error> => {
  try {
    const client = new WebClient(props.botToken)
    return await client.apiCall(props.method, props.body ?? {})
  } catch (err) {
    if (err instanceof Error) return err
    return new Error(String(err))
  }
}

type ResolveProps = {
  project: Project
  agent: Agent
  channelName?: string
}

/**
 * Pick the bot token to use for a tenant's Slack API call. Defaults to the
 * first enabled channel's tokens (single-channel agents are the common case);
 * if `channelName` is given, requires that exact channel.
 */
export const resolveSlackTokens = (
  props: ResolveProps,
): { botToken: string; appToken: string; channelName: string } | Error => {
  const candidates = props.agent.channels.filter(
    (ch): ch is SlackChannel => ch.type === "slack" && ch.enabled,
  )

  if (props.channelName !== undefined) {
    const match = candidates.find((ch) => ch.name === props.channelName)
    if (!match) {
      return new Error(
        `slack channel '${props.channelName}' not found (or disabled) in ${props.project.name}/${props.agent.name}`,
      )
    }
    return { botToken: match.botToken, appToken: match.appToken, channelName: match.name }
  }

  const first = candidates[0]
  if (!first) {
    return new Error(
      `${props.project.name}/${props.agent.name} has no enabled slack channel to use`,
    )
  }
  return { botToken: first.botToken, appToken: first.appToken, channelName: first.name }
}
