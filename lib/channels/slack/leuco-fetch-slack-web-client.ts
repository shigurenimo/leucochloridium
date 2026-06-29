import { z } from "zod"
import {
  LeucoSlackWebClient,
  type SlackAuthTest,
  type SlackConversationInfo,
  type SlackConversationList,
  type SlackHistoryMessage,
  type SlackHistorySlice,
  type SlackSearchMessages,
} from "@/channels/slack/leuco-slack-web-client"

type Props = {
  botToken: string
}

const SLACK_API_BASE = "https://slack.com/api"

/**
 * Raw-fetch implementation of `LeucoSlackWebClient`. Calls
 * `POST https://slack.com/api/<method>` with a bearer token, parses the
 * common `{ ok, error?, ... }` envelope, and normalizes the result into the
 * port's flat shapes. No `@slack/web-api` dependency.
 */
export class LeucoFetchSlackWebClient extends LeucoSlackWebClient {
  constructor(private readonly props: Props) {
    super()
    Object.freeze(this)
  }

  async chatPostMessage(args: {
    channel: string
    threadTs: string | null
    text: string
  }): Promise<void> {
    const body: Record<string, unknown> = { channel: args.channel, text: args.text }
    if (args.threadTs !== null) body.thread_ts = args.threadTs

    await this.callOk("chat.postMessage", body)
  }

  async reactionsAdd(args: { channel: string; timestamp: string; name: string }): Promise<void> {
    await this.callOk("reactions.add", {
      channel: args.channel,
      timestamp: args.timestamp,
      name: args.name,
    })
  }

  async reactionsRemove(args: { channel: string; timestamp: string; name: string }): Promise<void> {
    await this.callOk("reactions.remove", {
      channel: args.channel,
      timestamp: args.timestamp,
      name: args.name,
    })
  }

  async conversationsInfo(args: { channel: string }): Promise<SlackConversationInfo> {
    const raw = await this.callOk("conversations.info", { channel: args.channel })
    const parsed = conversationsInfoSchema.safeParse(raw)
    if (!parsed.success) return { isMember: null }
    return { isMember: parsed.data.channel.is_member ?? null }
  }

  async conversationsReplies(args: {
    channel: string
    ts: string
    oldest: string | null
    inclusive: boolean | null
    limit: number | null
  }): Promise<SlackHistorySlice> {
    const body: Record<string, unknown> = { channel: args.channel, ts: args.ts }
    if (args.oldest !== null) body.oldest = args.oldest
    if (args.inclusive !== null) body.inclusive = args.inclusive
    if (args.limit !== null) body.limit = args.limit

    return await this.history("conversations.replies", body)
  }

  async conversationsList(args: {
    types: string
    limit: number | null
  }): Promise<SlackConversationList> {
    const body: Record<string, unknown> = { types: args.types }
    if (args.limit !== null) body.limit = args.limit

    const raw = await this.callOk("conversations.list", body)
    const parsed = conversationsListSchema.safeParse(raw)
    if (!parsed.success) return { channels: [] }

    const channels = parsed.data.channels.flatMap((channel) => {
      if (channel.id === undefined) return []
      return [{ id: channel.id, isIm: channel.is_im === true }]
    })
    return { channels }
  }

  async conversationsHistory(args: {
    channel: string
    oldest: string | null
    inclusive: boolean | null
    limit: number | null
  }): Promise<SlackHistorySlice> {
    const body: Record<string, unknown> = { channel: args.channel }
    if (args.oldest !== null) body.oldest = args.oldest
    if (args.inclusive !== null) body.inclusive = args.inclusive
    if (args.limit !== null) body.limit = args.limit

    return await this.history("conversations.history", body)
  }

  async searchMessages(args: {
    query: string
    sort: "timestamp" | "score" | null
    sortDir: "asc" | "desc" | null
    count: number | null
  }): Promise<SlackSearchMessages> {
    const body: Record<string, unknown> = { query: args.query }
    if (args.sort !== null) body.sort = args.sort
    if (args.sortDir !== null) body.sort_dir = args.sortDir
    if (args.count !== null) body.count = args.count

    const raw = await this.callOk("search.messages", body, "form")
    const parsed = searchMessagesSchema.safeParse(raw)
    if (!parsed.success) return { matches: [] }

    const matches = (parsed.data.messages?.matches ?? []).flatMap((match) => {
      if (match.channel?.id === undefined) return []
      if (match.ts === undefined) return []
      return [
        {
          channelId: match.channel.id,
          user: match.user ?? null,
          text: match.text ?? null,
          ts: match.ts,
          permalink: match.permalink ?? null,
        },
      ]
    })
    return { matches }
  }

  async authTest(): Promise<SlackAuthTest> {
    const raw = await this.callOk("auth.test", {})
    const parsed = authTestSchema.safeParse(raw)
    if (!parsed.success) return { userId: null }
    return { userId: parsed.data.user_id ?? null }
  }

  async apiCall(method: string, body: Record<string, unknown>): Promise<unknown> {
    return await this.post(method, body)
  }

  private async history(method: string, body: Record<string, unknown>): Promise<SlackHistorySlice> {
    const raw = await this.callOk(method, body)
    const parsed = historySchema.safeParse(raw)
    if (!parsed.success) return { messages: [] }

    const messages: SlackHistoryMessage[] = parsed.data.messages.flatMap((message) => {
      if (message.ts === undefined) return []
      return [
        {
          user: message.user ?? null,
          text: message.text ?? null,
          ts: message.ts,
          threadTs: message.thread_ts ?? null,
          subtype: message.subtype ?? null,
          botId: message.bot_id ?? null,
        },
      ]
    })
    return { messages }
  }

  private async callOk(
    method: string,
    body: Record<string, unknown>,
    encoding: "json" | "form" = "json",
  ): Promise<unknown> {
    const raw = encoding === "form" ? await this.postForm(method, body) : await this.post(method, body)
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`slack ${method}: response is not an object`)
    }
    const okField = (raw as { ok?: unknown }).ok
    if (okField !== true) {
      const errField = (raw as { error?: unknown }).error
      const reason = typeof errField === "string" ? errField : "unknown"
      throw new Error(`slack ${method}: ${reason}`)
    }
    return raw
  }

  private async post(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.props.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`slack ${method} http ${response.status} ${response.statusText}`)
    }

    return await response.json()
  }

  private async postForm(method: string, body: Record<string, unknown>): Promise<unknown> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(body)) {
      if (value === null || value === undefined) continue
      params.set(key, String(value))
    }

    const response = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.props.botToken}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: params.toString(),
    })

    if (!response.ok) {
      throw new Error(`slack ${method} http ${response.status} ${response.statusText}`)
    }

    return await response.json()
  }
}

const authTestSchema = z
  .object({
    user_id: z.string().optional(),
  })
  .passthrough()

const conversationsInfoSchema = z
  .object({
    channel: z
      .object({
        is_member: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough()

const historyMessageSchema = z
  .object({
    user: z.string().optional(),
    text: z.string().optional(),
    ts: z.string().optional(),
    thread_ts: z.string().optional(),
    subtype: z.string().optional(),
    bot_id: z.string().optional(),
  })
  .passthrough()

const historySchema = z
  .object({
    messages: z.array(historyMessageSchema).default([]),
  })
  .passthrough()

const conversationsListSchema = z
  .object({
    channels: z
      .array(
        z
          .object({
            id: z.string().optional(),
            is_im: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough()

const searchMessagesSchema = z
  .object({
    messages: z
      .object({
        matches: z
          .array(
            z
              .object({
                channel: z.object({ id: z.string().optional() }).passthrough().optional(),
                user: z.string().optional(),
                text: z.string().optional(),
                ts: z.string().optional(),
                permalink: z.string().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
