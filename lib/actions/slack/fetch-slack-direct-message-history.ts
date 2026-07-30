import type {
  LeucoSlackWebClient,
  SlackHistoryMessage,
} from "@/connectors/slack/leuco-slack-web-client"

type Props = {
  client: LeucoSlackWebClient
  conversationId: string
  limit: number
}

export const fetchSlackDirectMessageHistory = async (
  props: Props,
): Promise<ReadonlyArray<SlackHistoryMessage>> => {
  const history = await props.client.conversationsHistory({
    channel: props.conversationId,
    oldest: null,
    inclusive: null,
    limit: props.limit,
  })
  const messages = new Map(history.messages.map((message) => [message.ts, message]))

  for (const message of history.messages) {
    if (message.threadTs !== null || message.replyCount === null || message.replyCount < 1) continue

    const replies = await props.client.conversationsReplies({
      channel: props.conversationId,
      ts: message.ts,
      oldest: null,
      inclusive: null,
      limit: Math.max(2, props.limit),
    })
    for (const reply of replies.messages) messages.set(reply.ts, reply)
  }

  return Array.from(messages.values())
}
