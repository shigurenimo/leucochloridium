import {
  LeucoSlackWebClient,
  type SlackAuthTest,
  type SlackConversationInfo,
  type SlackConversationList,
  type SlackHistorySlice,
  type SlackSearchMessages,
} from "@/channels/slack/leuco-slack-web-client"

type Responder<T, A> = ((args: A) => Promise<T> | T) | T

type Props = {
  chatPostMessage?: Responder<void, { channel: string; threadTs: string | null; text: string }>
  reactionsAdd?: Responder<void, { channel: string; timestamp: string; name: string }>
  reactionsRemove?: Responder<void, { channel: string; timestamp: string; name: string }>
  conversationsInfo?: Responder<SlackConversationInfo, { channel: string }>
  conversationsReplies?: Responder<
    SlackHistorySlice,
    {
      channel: string
      ts: string
      oldest: string | null
      inclusive: boolean | null
      limit: number | null
    }
  >
  conversationsList?: Responder<SlackConversationList, { types: string; limit: number | null }>
  conversationsHistory?: Responder<
    SlackHistorySlice,
    { channel: string; oldest: string | null; inclusive: boolean | null; limit: number | null }
  >
  searchMessages?: Responder<
    SlackSearchMessages,
    {
      query: string
      sort: "timestamp" | "score" | null
      sortDir: "asc" | "desc" | null
      count: number | null
    }
  >
  authTest?: Responder<SlackAuthTest, void>
  apiCall?: Responder<unknown, { method: string; body: Record<string, unknown> }>
}

/**
 * In-memory test double for `LeucoSlackWebClient`. Every method records the
 * call site for assertion (`calls.<method>`) and replies via the matching
 * `Props` field — either a fixed value or a function that takes the call args.
 */
export class LeucoMemorySlackWebClient extends LeucoSlackWebClient {
  readonly calls: {
    chatPostMessage: Array<{ channel: string; threadTs: string | null; text: string }>
    reactionsAdd: Array<{ channel: string; timestamp: string; name: string }>
    reactionsRemove: Array<{ channel: string; timestamp: string; name: string }>
    conversationsInfo: Array<{ channel: string }>
    conversationsReplies: Array<{
      channel: string
      ts: string
      oldest: string | null
      inclusive: boolean | null
      limit: number | null
    }>
    conversationsList: Array<{ types: string; limit: number | null }>
    conversationsHistory: Array<{
      channel: string
      oldest: string | null
      inclusive: boolean | null
      limit: number | null
    }>
    searchMessages: Array<{
      query: string
      sort: "timestamp" | "score" | null
      sortDir: "asc" | "desc" | null
      count: number | null
    }>
    authTest: Array<void>
    apiCall: Array<{ method: string; body: Record<string, unknown> }>
  }

  constructor(private readonly props: Props = {}) {
    super()
    this.calls = {
      chatPostMessage: [],
      reactionsAdd: [],
      reactionsRemove: [],
      conversationsInfo: [],
      conversationsReplies: [],
      conversationsList: [],
      conversationsHistory: [],
      searchMessages: [],
      authTest: [],
      apiCall: [],
    }
  }

  async chatPostMessage(args: {
    channel: string
    threadTs: string | null
    text: string
  }): Promise<void> {
    this.calls.chatPostMessage.push(args)

    return this.invoke(this.props.chatPostMessage, args, undefined as void)
  }

  async reactionsAdd(args: { channel: string; timestamp: string; name: string }): Promise<void> {
    this.calls.reactionsAdd.push(args)

    return this.invoke(this.props.reactionsAdd, args, undefined as void)
  }

  async reactionsRemove(args: { channel: string; timestamp: string; name: string }): Promise<void> {
    this.calls.reactionsRemove.push(args)

    return this.invoke(this.props.reactionsRemove, args, undefined as void)
  }

  async conversationsInfo(args: { channel: string }): Promise<SlackConversationInfo> {
    this.calls.conversationsInfo.push(args)

    return this.invoke(this.props.conversationsInfo, args, { isMember: true })
  }

  async conversationsReplies(args: {
    channel: string
    ts: string
    oldest: string | null
    inclusive: boolean | null
    limit: number | null
  }): Promise<SlackHistorySlice> {
    this.calls.conversationsReplies.push(args)

    return this.invoke(this.props.conversationsReplies, args, { messages: [] })
  }

  async conversationsList(args: {
    types: string
    limit: number | null
  }): Promise<SlackConversationList> {
    this.calls.conversationsList.push(args)

    return this.invoke(this.props.conversationsList, args, { channels: [] })
  }

  async conversationsHistory(args: {
    channel: string
    oldest: string | null
    inclusive: boolean | null
    limit: number | null
  }): Promise<SlackHistorySlice> {
    this.calls.conversationsHistory.push(args)

    return this.invoke(this.props.conversationsHistory, args, { messages: [] })
  }

  async searchMessages(args: {
    query: string
    sort: "timestamp" | "score" | null
    sortDir: "asc" | "desc" | null
    count: number | null
  }): Promise<SlackSearchMessages> {
    this.calls.searchMessages.push(args)

    return this.invoke(this.props.searchMessages, args, { matches: [] })
  }

  async authTest(): Promise<SlackAuthTest> {
    this.calls.authTest.push(undefined as void)

    return this.invoke(this.props.authTest, undefined as void, { userId: null })
  }

  async apiCall(method: string, body: Record<string, unknown>): Promise<unknown> {
    const call = { method, body }
    this.calls.apiCall.push(call)

    return this.invoke(this.props.apiCall, call, { ok: true })
  }

  private async invoke<T, A>(
    responder: Responder<T, A> | undefined,
    args: A,
    fallback: T,
  ): Promise<T> {
    if (responder === undefined) return fallback
    if (typeof responder === "function") {
      const fn = responder as (args: A) => Promise<T> | T
      return await fn(args)
    }
    return responder
  }
}
