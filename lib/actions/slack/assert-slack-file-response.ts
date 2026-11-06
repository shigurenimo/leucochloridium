import { cancelSlackResponseBody } from "@/connectors/slack/cancel-slack-response-body"

export async function assertSlackFileResponse(response: Response): Promise<void> {
  if (response.ok) return

  const failure = new Error(`Slack file download failed: HTTP ${response.status}`)
  await cancelSlackResponseBody(response, { error: failure })
  throw failure
}
