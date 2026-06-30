/**
 * Outbound port for Slack Web API. The adapter and the `slack_call` action
 * depend on this abstract class. Real traffic goes through
 * `LeucoFetchSlackWebClient` (raw fetch over `https://slack.com/api/...`); tests
 * substitute `LeucoMemorySlackWebClient`.
 */
export abstract class LeucoSlackWebClient {
  abstract chatPostMessage(args: {
    channel: string
    threadTs: string | null
    text: string
  }): Promise<void>

  abstract reactionsAdd(args: { channel: string; timestamp: string; name: string }): Promise<void>

  abstract reactionsRemove(args: {
    channel: string
    timestamp: string
    name: string
  }): Promise<void>

  abstract conversationsInfo(args: { channel: string }): Promise<SlackConversationInfo>

  abstract conversationsReplies(args: {
    channel: string
    ts: string
    oldest: string | null
    inclusive: boolean | null
    limit: number | null
  }): Promise<SlackHistorySlice>

  abstract conversationsList(args: {
    types: string
    limit: number | null
  }): Promise<SlackConversationList>

  abstract conversationsHistory(args: {
    channel: string
    oldest: string | null
    inclusive: boolean | null
    limit: number | null
  }): Promise<SlackHistorySlice>

  abstract searchMessages(args: {
    query: string
    sort: "timestamp" | "score" | null
    sortDir: "asc" | "desc" | null
    count: number | null
  }): Promise<SlackSearchMessages>

  abstract authTest(): Promise<SlackAuthTest>

  abstract apiCall(method: string, body: Record<string, unknown>): Promise<unknown>
}

export type SlackAuthTest = {
  userId: string | null
}

export type SlackConversationInfo = {
  isMember: boolean | null
}

export type SlackHistoryMessage = {
  user: string | null
  text: string | null
  ts: string
  threadTs: string | null
  subtype: string | null
  botId: string | null
}

export type SlackHistorySlice = {
  messages: ReadonlyArray<SlackHistoryMessage>
}

export type SlackConversationListEntry = {
  id: string
  isIm: boolean
}

export type SlackConversationList = {
  channels: ReadonlyArray<SlackConversationListEntry>
}

export type SlackSearchMessageMatch = {
  channelId: string
  user: string | null
  text: string | null
  ts: string
  permalink: string | null
}

export type SlackSearchMessages = {
  matches: ReadonlyArray<SlackSearchMessageMatch>
}
