import type {
  LeucoSlackWebClient,
  SlackHistoryMessage,
} from "@/connectors/slack/leuco-slack-web-client"

export type LatestSlackDirectMessage = {
  conversationId: string
  message: SlackHistoryMessage
  messages: ReadonlyArray<SlackHistoryMessage>
}

type Props = {
  client: LeucoSlackWebClient
  botUserId: string | null
  historyLimit: number
}

const CONVERSATION_PAGE_LIMIT = 200

/**
 * Find the newest human-authored message across every DM visible to the
 * project's Slack token. `conversations.list` is cursor-paginated; each
 * history page is fetched once and retained for the existing diagnosis step.
 */
export const findLatestSlackDirectMessage = async (
  props: Props,
): Promise<LatestSlackDirectMessage | null> => {
  const seenConversationIds = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  let latest: LatestSlackDirectMessage | null = null
  let hasMore = true

  while (hasMore) {
    const page = await props.client.conversationsList({
      types: "im",
      limit: CONVERSATION_PAGE_LIMIT,
      cursor,
    })

    const conversations = page.channels.filter(
      (conversation) => conversation.isIm && !seenConversationIds.has(conversation.id),
    )
    for (const conversation of conversations) seenConversationIds.add(conversation.id)

    // Keep history reads sequential. A workspace can expose hundreds of DMs,
    // and firing one request per conversation at once would create a burst
    // large enough to trigger Slack's per-method rate limits.
    for (const conversation of conversations) {
      const history = await props.client.conversationsHistory({
        channel: conversation.id,
        oldest: null,
        inclusive: null,
        limit: props.historyLimit,
      })
      const message = findLatestHumanMessage(history.messages, props.botUserId)
      if (message === null) continue
      if (latest !== null && slackTs(message.ts) <= slackTs(latest.message.ts)) continue
      latest = {
        conversationId: conversation.id,
        message,
        messages: history.messages,
      }
    }

    const nextCursor = page.nextCursor?.trim() || null
    if (nextCursor === null || seenCursors.has(nextCursor)) {
      hasMore = false
    } else {
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }
  }

  return latest
}

const findLatestHumanMessage = (
  messages: ReadonlyArray<SlackHistoryMessage>,
  botUserId: string | null,
): SlackHistoryMessage | null => {
  let latest: SlackHistoryMessage | null = null
  for (const message of messages) {
    if (message.subtype !== null) continue
    if (message.botId !== null) continue
    if (botUserId !== null && message.user === botUserId) continue
    if (latest === null || slackTs(message.ts) > slackTs(latest.ts)) latest = message
  }
  return latest
}

const slackTs = (value: string): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
