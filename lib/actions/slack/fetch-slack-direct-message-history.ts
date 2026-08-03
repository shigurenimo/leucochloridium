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

    const seenCursors = new Set<string>()
    const cursors: Array<string | null> = [null]
    for (const cursor of cursors) {
      const replies = await props.client.conversationsReplies({
        channel: props.conversationId,
        ts: message.ts,
        oldest: null,
        inclusive: null,
        limit: Math.max(2, props.limit),
        cursor,
      })
      for (const reply of replies.messages) messages.set(reply.ts, reply)

      const nextCursor = replies.nextCursor?.trim() || null
      if (nextCursor !== null && !seenCursors.has(nextCursor)) {
        seenCursors.add(nextCursor)
        cursors.push(nextCursor)
      }
    }
  }

  return Array.from(messages.values())
}
