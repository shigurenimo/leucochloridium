import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import type { Project, SlackConnectorConfig } from "@/config/config-schema"

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
  connectorName?: string
}

export const resolveSlackTokens = (
  props: ResolveProps,
): { botToken: string; appToken: string; connectorName: string } => {
  const candidates = props.project.connectors.filter(
    (ch): ch is SlackConnectorConfig => ch.type === "slack" && ch.enabled,
  )

  if (props.connectorName !== undefined) {
    const match = candidates.find((connector) => connector.name === props.connectorName)
    if (!match) {
      throw new Error(
        `slack connector '${props.connectorName}' not found (or disabled) in ${props.project.name}`,
      )
    }
    return { botToken: match.botToken, appToken: match.appToken, connectorName: match.name }
  }

  const first = candidates[0]
  if (!first) {
    throw new Error(`${props.project.name} has no enabled Slack connector to use`)
  }
  return { botToken: first.botToken, appToken: first.appToken, connectorName: first.name }
}
