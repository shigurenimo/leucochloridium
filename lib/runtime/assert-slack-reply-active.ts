import { cancelSlackResponseBody } from "@/connectors/slack/cancel-slack-response-body"

export async function assertSlackReplyActive(reply: unknown, signal: AbortSignal): Promise<void> {
  if (!signal.aborted) return
  const failure = signal.reason
  if (reply instanceof Response) await cancelSlackResponseBody(reply, { error: failure })
  throw failure
}
