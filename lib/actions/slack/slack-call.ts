import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"

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
