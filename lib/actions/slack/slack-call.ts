import { LeucoFetchSlackWebClient } from "@/channels/slack/leuco-fetch-slack-web-client"
import type { Project, SlackChannel } from "@/config/config-schema"

type Props = {
  botToken: string
  method: string
  body?: Record<string, unknown>
}

export const slackCall = async (props: Props): Promise<unknown> => {
  const client = new LeucoFetchSlackWebClient({ botToken: props.botToken })

  return await client.apiCall(props.method, sanitiseBody(props.body))
}

const sanitiseBody = (body: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (!body) return {}
  if (!("token" in body)) return body
  const sanitised: Record<string, unknown> = {}
  for (const key of Object.keys(body)) {
    if (key === "token") continue
    sanitised[key] = body[key]
  }
  return sanitised
}

type ResolveProps = {
  project: Project
  channelName?: string
}

export const resolveSlackTokens = (
  props: ResolveProps,
): { botToken: string; appToken: string; channelName: string } => {
  const candidates = props.project.channels.filter(
    (ch): ch is SlackChannel => ch.type === "slack" && ch.enabled,
  )

  if (props.channelName !== undefined) {
    const match = candidates.find((ch) => ch.name === props.channelName)
    if (!match) {
      throw new Error(
        `slack channel '${props.channelName}' not found (or disabled) in ${props.project.name}`,
      )
    }
    return { botToken: match.botToken, appToken: match.appToken, channelName: match.name }
  }

  const first = candidates[0]
  if (!first) {
    throw new Error(`${props.project.name} has no enabled slack channel to use`)
  }
  return { botToken: first.botToken, appToken: first.appToken, channelName: first.name }
}
