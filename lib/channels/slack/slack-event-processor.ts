import {
  slackAppMentionEventSchema,
  slackMessageEventSchema,
  slackReactionEventSchema,
} from "@/channels/slack/slack-schemas"
import type {
  SlackEvent,
  SlackMessageEvent,
  SlackReactionEvent,
} from "@/channels/slack/slack-types"

type Props = {
  botUserId: string | null
  /** Hard cap on the dedup map; events older than the TTL are evicted lazily. */
  dedupCapacity?: number
  /** TTL in ms. Slack redelivers within ~3s; 5 min is generous. */
  dedupTtlMs?: number
  /** Clock injection for tests. */
  now?: () => number
}

export type ProcessSkip = { skip: true; reason: string }
export type ProcessEmit = { skip: false; event: SlackEvent }
export type ProcessResult = ProcessSkip | ProcessEmit

const DEFAULT_DEDUP_CAPACITY = 10_000
const DEFAULT_DEDUP_TTL_MS = 5 * 60 * 1000

/**
 * Pure decision layer for Slack incoming events. Owns:
 *  - schema validation of raw event payloads
 *  - dedup (time-windowed; key → expiresAt)
 *  - filtering of bot self-messages and subtype noise
 *  - normalization into a `SlackEvent` union
 *
 * No mention gating, no thread tracking. Every channel event the bot sees
 * is forwarded verbatim to the agent; the agent decides whether to respond
 * using the metadata in the envelope.
 */
export class LeucoSlackEventProcessor {
  private readonly dedupCapacity: number
  private readonly dedupTtlMs: number
  private readonly now: () => number
  private readonly seenKeys = new Map<string, number>()
  private botUserId: string | null

  constructor(props: Props) {
    this.botUserId = props.botUserId
    this.dedupCapacity = props.dedupCapacity ?? DEFAULT_DEDUP_CAPACITY
    this.dedupTtlMs = props.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS
    this.now = props.now ?? Date.now
  }

  /**
   * Upgrade the bot identity in place once `auth.test` resolves. Done as a
   * mutator (rather than rebuilding the processor) so the dedup window
   * accumulated during the `app.start()` → `auth.test` race window survives.
   */
  setBotUserId(botUserId: string | null): void {
    this.botUserId = botUserId
  }

  processAppMention(event: unknown): ProcessResult {
    const parsed = slackAppMentionEventSchema.safeParse(event)
    if (!parsed.success) {
      return { skip: true, reason: `app_mention schema failed: ${parsed.error.message}` }
    }
    const data = parsed.data

    // Same self/bot filter the `message` path enforces. Without this, an
    // `app_mention` from the bot's own reply (or a bot-to-bot mention chain)
    // would dispatch a turn — and because `message` events skip BEFORE
    // calling `consume()`, the dedup key is still fresh when the matching
    // `app_mention` arrives, so nothing prevents the loop downstream.
    if (data.bot_id !== undefined) return { skip: true, reason: "bot_id present" }
    if (this.botUserId === null) return { skip: true, reason: "botUserId unknown" }
    if (data.user === this.botUserId) return { skip: true, reason: "self app_mention" }

    return this.dispatchMessage(data, "app_mention")
  }

  processMessage(event: unknown): ProcessResult {
    const parsed = slackMessageEventSchema.safeParse(event)
    if (!parsed.success) return { skip: true, reason: "message schema failed" }
    const data = parsed.data

    if (data.subtype !== undefined) return { skip: true, reason: `subtype=${data.subtype}` }
    if (data.bot_id !== undefined) return { skip: true, reason: "bot_id present" }
    if (this.botUserId === null) return { skip: true, reason: "botUserId unknown" }
    if (data.user === this.botUserId) return { skip: true, reason: "self message" }

    // DMs always reach the agent — a DM opening with someone else's mention
    // ("<@U123> をアサインして") is still a request to the bot.
    const isDirectMessage = data.channel.startsWith("D")
    if (!isDirectMessage && isAddressedToAnotherUser(data.text ?? "", this.botUserId)) {
      return { skip: true, reason: "addressed to another user" }
    }

    return this.dispatchMessage(data, "message")
  }

  processReaction(event: unknown): ProcessResult {
    const parsed = slackReactionEventSchema.safeParse(event)
    if (!parsed.success) return { skip: true, reason: "reaction schema failed" }
    const data = parsed.data

    if (this.botUserId === null) return { skip: true, reason: "botUserId unknown" }
    if (data.user === this.botUserId) {
      return { skip: true, reason: "self reaction" }
    }

    const dedupKey = `${data.type}:${data.event_ts}:${data.user}:${data.reaction}:${data.item.ts}`
    if (!this.consume(dedupKey)) return { skip: true, reason: `dedup ${dedupKey}` }

    const reaction: SlackReactionEvent = {
      kind: data.type,
      channel: data.item.channel,
      user: data.user,
      emoji: data.reaction,
      targetTs: data.item.ts,
      targetUser: data.item_user ?? null,
    }
    return { skip: false, event: reaction }
  }

  private dispatchMessage(
    data: {
      channel: string
      user?: string
      text?: string
      ts: string
      thread_ts?: string
    },
    source: "app_mention" | "message",
  ): ProcessResult {
    // Slack ts is only unique per channel, so the key needs both. The
    // `app_mention` and `message` events for the same post share channel+ts
    // and must keep deduping against each other.
    if (!this.consume(`msg:${data.channel}:${data.ts}`)) {
      return { skip: true, reason: `dedup ts=${data.ts}` }
    }

    const rawText = data.text ?? ""
    const mentioned = data.channel.startsWith("D") || slackTextMentionsUser(rawText, this.botUserId)
    const text = stripMention(rawText, this.botUserId)
    const threadTs = data.thread_ts ?? data.ts

    const message: SlackMessageEvent = {
      kind: "message",
      channel: data.channel,
      user: data.user ?? "unknown",
      rawText,
      text,
      threadTs,
      ts: data.ts,
      isThreadRoot: threadTs === data.ts,
      mentioned,
      source,
    }
    return { skip: false, event: message }
  }

  /**
   * Time-windowed dedup. Returns true when the key is fresh (not seen within
   * the TTL), false when already seen. A capacity cap evicts the oldest entry
   * if the map grows past the bound — this protects against bursts so large
   * the TTL alone cannot keep up.
   */
  private consume(key: string): boolean {
    const now = this.now()
    const existing = this.seenKeys.get(key)
    if (existing !== undefined && existing > now) return false

    // Replacing the entry moves it to the tail of the Map's insertion order,
    // which is what `keys().next().value` evicts when capacity is hit.
    this.seenKeys.delete(key)
    this.seenKeys.set(key, now + this.dedupTtlMs)

    if (this.seenKeys.size > this.dedupCapacity) {
      const first = this.seenKeys.keys().next().value
      if (typeof first === "string") this.seenKeys.delete(first)
    }
    return true
  }
}

const stripMention = (text: string, botUserId: string | null): string => {
  if (botUserId === null) return text.trim()
  return text.replace(slackMentionRegex(botUserId), "").trim()
}

export const slackTextMentionsUser = (text: string, userId: string | null): boolean => {
  if (userId === null) return false
  return slackMentionRegex(userId).test(text)
}

const slackMentionRegex = (userId: string): RegExp => {
  return new RegExp(`<@${escapeRegExp(userId)}(?:\\|[^>]+)?>`, "g")
}

const isAddressedToAnotherUser = (text: string, botUserId: string): boolean => {
  const firstToken = text.trimStart().match(/^<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/)
  return firstToken !== null && firstToken[1] !== botUserId
}

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
