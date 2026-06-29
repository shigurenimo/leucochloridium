import type {
  LeucoSlackWebClient,
  SlackHistoryMessage,
  SlackSearchMessageMatch,
} from "@/channels/slack/leuco-slack-web-client"
import { slackTextMentionsUser } from "@/channels/slack/slack-event-processor"
import { errorMessage } from "@/error-message"

type DispatchRawMessage = (raw: {
  channel: string
  user: string | null
  text: string | null
  ts: string
  threadTs: string | null
  subtype: string | null
  botId: string | null
}) => Promise<void>

export type XoxpPollerErrorAction =
  | "dm.poll.failed"
  | "mention.poll.failed"
  | "own-reply.poll.failed"

type Props = {
  client: LeucoSlackWebClient
  botUserId: string
  dispatchMessage: DispatchRawMessage
  rememberActiveThread: (channel: string, threadTs: string) => void
  onLog: (line: string) => void
  /**
   * Surface a structured slack.error to the bus. Without this, xoxp polling
   * failures (401 / 429 / network) only land in the diagnostic log and are
   * invisible to `leuco events --preset errors`.
   */
  onError?: (props: { action: XoxpPollerErrorAction; message: string; error: string }) => void
}

const DM_POLL_INTERVAL_MS = 15_000
const DM_POLL_START_LOOKBACK_MS = 30 * 60_000
const DM_POLL_HISTORY_LIMIT = 20
const MENTION_POLL_INTERVAL_MS = 30_000
const MENTION_POLL_START_LOOKBACK_MS = 30 * 60_000
const MENTION_POLL_SEARCH_COUNT = 50
const MENTION_POLL_BOOTSTRAP_UNANSWERED_LIMIT = 3
const OWN_REPLY_POLL_INTERVAL_MS = 30_000
const OWN_REPLY_POLL_SEARCH_COUNT = 50

/**
 * xoxp (user-token) poller. When a Slack workspace gives the bot a user token
 * instead of a bot token, the Events API stops delivering `app_mention` and
 * many `message` deliveries. This poller fills the gap with three loops:
 *
 *  - DM poller: `conversations.list(types=im)` + `conversations.history` per IM
 *  - Mention poller: `search.messages` for `<@botUserId>`, dispatching the
 *    unanswered ones (with bootstrap cap on first run)
 *  - Own-reply poller: `search.messages` for `from:<@botUserId>`, marking the
 *    surrounding threads as active and dispatching the latest non-bot
 *    follow-up so subsequent in-thread messages get treated as mentioned
 *
 * `LeucoSlackXoxpPoller` is constructed only when `botToken.startsWith("xoxp-")`.
 */
export class LeucoSlackXoxpPoller {
  private dmPollTimer: ReturnType<typeof setInterval> | null = null
  private mentionPollTimer: ReturnType<typeof setInterval> | null = null
  private ownReplyPollTimer: ReturnType<typeof setInterval> | null = null
  private dmPollInflight = false
  private mentionPollInflight = false
  private ownReplyPollInflight = false
  private dmPollOldestByChannel = new Map<string, number>()
  private mentionPollOldest = mentionPollStartOldest()
  private mentionPollBootstrapped = false
  private stopping = false

  constructor(private readonly props: Props) {}

  start(): void {
    this.stopping = false
    this.startDmPoller()
    this.startMentionPoller()
    this.startOwnReplyPoller()
  }

  stop(): void {
    this.stopping = true
    this.stopTimer(this.dmPollTimer)
    this.stopTimer(this.mentionPollTimer)
    this.stopTimer(this.ownReplyPollTimer)
    this.dmPollTimer = null
    this.mentionPollTimer = null
    this.ownReplyPollTimer = null
  }

  private startDmPoller(): void {
    if (this.dmPollTimer !== null) return

    this.props.onLog("dm poller started for xoxp token")
    this.dmPollTimer = setInterval(() => {
      void this.pollDms()
    }, DM_POLL_INTERVAL_MS)
    unrefTimer(this.dmPollTimer)
    void this.pollDms()
  }

  private startMentionPoller(): void {
    if (this.mentionPollTimer !== null) return

    this.props.onLog("mention poller started for xoxp token")
    this.mentionPollTimer = setInterval(() => {
      void this.pollMentions()
    }, MENTION_POLL_INTERVAL_MS)
    unrefTimer(this.mentionPollTimer)
    void this.pollMentions()
  }

  private startOwnReplyPoller(): void {
    if (this.ownReplyPollTimer !== null) return

    this.props.onLog("own reply poller started for xoxp token")
    this.ownReplyPollTimer = setInterval(() => {
      void this.pollOwnReplies()
    }, OWN_REPLY_POLL_INTERVAL_MS)
    unrefTimer(this.ownReplyPollTimer)
    void this.pollOwnReplies()
  }

  private async pollDms(): Promise<void> {
    if (this.stopping || this.dmPollInflight) return

    this.dmPollInflight = true
    try {
      const list = await this.props.client.conversationsList({ types: "im", limit: 200 })
      const channels = list.channels.filter((channel) => channel.isIm).map((channel) => channel.id)
      for (const channel of channels) {
        await this.pollDmChannel(channel)
      }
    } catch (err) {
      const message = errorMessage(err)
      this.props.onLog(`dm poll failed: ${message}`)
      this.props.onError?.({ action: "dm.poll.failed", message, error: message })
    } finally {
      this.dmPollInflight = false
    }
  }

  private async pollDmChannel(channel: string): Promise<void> {
    const oldest = this.dmPollOldestByChannel.get(channel) ?? dmPollStartOldest()
    const history = await this.props.client.conversationsHistory({
      channel,
      oldest: oldest.toFixed(6),
      inclusive: false,
      limit: DM_POLL_HISTORY_LIMIT,
    })
    const messages = sortHistoryByTs(history.messages)

    for (const message of messages) {
      const tsNumber = Number(message.ts)
      if (Number.isFinite(tsNumber)) {
        this.dmPollOldestByChannel.set(channel, Math.max(oldest, tsNumber))
      }
      await this.props.dispatchMessage({
        channel,
        user: message.user,
        text: message.text,
        ts: message.ts,
        threadTs: message.threadTs,
        subtype: message.subtype,
        botId: message.botId,
      })
    }
  }

  private async pollMentions(): Promise<void> {
    if (this.stopping || this.mentionPollInflight) return

    this.mentionPollInflight = true
    try {
      const result = await this.props.client.searchMessages({
        query: `<@${this.props.botUserId}>`,
        sort: "timestamp",
        sortDir: "desc",
        count: MENTION_POLL_SEARCH_COUNT,
      })
      const matches = result.matches
        .filter((match) => slackTextMentionsUser(match.text ?? "", this.props.botUserId))
        .filter((match) => {
          const ts = Number(match.ts)
          return Number.isFinite(ts) && ts > this.mentionPollOldest
        })
        .slice()
        .sort((a, b) => Number(b.ts) - Number(a.ts))

      const checkedFollowupThreads = new Set<string>()
      const unansweredMatches: SlackSearchMessageMatch[] = []
      let newestSeen = this.mentionPollOldest

      for (const match of matches) {
        const tsNumber = Number(match.ts)
        if (Number.isFinite(tsNumber)) newestSeen = Math.max(newestSeen, tsNumber)
        const threadTs = threadTsFromPermalink(match.permalink) ?? match.ts
        if (await this.hasBotReplyAfter(match.channelId, threadTs, match.ts)) {
          this.props.onLog(`mention poll skip answered channel=${match.channelId} ts=${match.ts}`)
          await this.dispatchLatestThreadFollowup(match.channelId, threadTs, checkedFollowupThreads)
          continue
        }
        unansweredMatches.push(match)
      }

      let unansweredDispatched = 0
      for (const match of unansweredMatches) {
        const threadTs = threadTsFromPermalink(match.permalink) ?? match.ts
        if (
          !this.mentionPollBootstrapped &&
          unansweredDispatched >= MENTION_POLL_BOOTSTRAP_UNANSWERED_LIMIT
        ) {
          this.props.onLog(
            `mention poll bootstrap skip old unanswered channel=${match.channelId} ts=${match.ts}`,
          )
          continue
        }
        unansweredDispatched += 1
        await this.props.dispatchMessage({
          channel: match.channelId,
          user: match.user,
          text: match.text,
          ts: match.ts,
          threadTs,
          subtype: null,
          botId: null,
        })
      }
      this.mentionPollOldest = newestSeen
      this.mentionPollBootstrapped = true
    } catch (err) {
      const message = errorMessage(err)
      this.props.onLog(`mention poll failed: ${message}`)
      this.props.onError?.({ action: "mention.poll.failed", message, error: message })
    } finally {
      this.mentionPollInflight = false
    }
  }

  private async pollOwnReplies(): Promise<void> {
    if (this.stopping || this.ownReplyPollInflight) return

    this.ownReplyPollInflight = true
    try {
      const result = await this.props.client.searchMessages({
        query: `from:<@${this.props.botUserId}>`,
        sort: "timestamp",
        sortDir: "desc",
        count: OWN_REPLY_POLL_SEARCH_COUNT,
      })
      const checkedThreads = new Set<string>()
      const matches = result.matches.filter((match) => match.user === this.props.botUserId)

      for (const match of matches) {
        const threadTs = threadTsFromPermalink(match.permalink) ?? match.ts
        this.props.rememberActiveThread(match.channelId, threadTs)
        await this.dispatchLatestThreadFollowup(match.channelId, threadTs, checkedThreads)
      }
    } catch (err) {
      const message = errorMessage(err)
      this.props.onLog(`own reply poll failed: ${message}`)
      this.props.onError?.({ action: "own-reply.poll.failed", message, error: message })
    } finally {
      this.ownReplyPollInflight = false
    }
  }

  private async hasBotReplyAfter(
    channel: string,
    threadTs: string,
    messageTs: string,
  ): Promise<boolean> {
    try {
      const replies = await this.props.client.conversationsReplies({
        channel,
        ts: threadTs,
        oldest: messageTs,
        inclusive: false,
        limit: 100,
      })

      return replies.messages.some((message) => message.user === this.props.botUserId)
    } catch (err) {
      this.props.onLog(
        `mention poll reply check failed channel=${channel} ts=${messageTs}: ${errorMessage(err)}`,
      )
      return false
    }
  }

  private async dispatchLatestThreadFollowup(
    channel: string,
    threadTs: string,
    checkedThreads: Set<string>,
  ): Promise<void> {
    const key = `${channel}:${threadTs}`
    if (checkedThreads.has(key)) return
    checkedThreads.add(key)

    try {
      const replies = await this.props.client.conversationsReplies({
        channel,
        ts: threadTs,
        oldest: null,
        inclusive: null,
        limit: 100,
      })
      const messages = sortHistoryByTs(replies.messages)
      const lastBotTs = latestBotMessageTs(messages, this.props.botUserId)
      if (lastBotTs === null) return
      this.props.rememberActiveThread(channel, threadTs)
      const latestFollowup = messages
        .filter((message) => Number(message.ts) > Number(lastBotTs))
        .filter((message) => message.user !== this.props.botUserId)
        .filter((message) => message.botId === null)
        .filter((message) => message.subtype === null)
        .at(-1)
      if (!latestFollowup) return

      this.props.onLog(
        `mention poll dispatch thread followup channel=${channel} ts=${latestFollowup.ts}`,
      )
      await this.props.dispatchMessage({
        channel,
        user: latestFollowup.user,
        text: latestFollowup.text,
        ts: latestFollowup.ts,
        threadTs: latestFollowup.threadTs ?? threadTs,
        subtype: latestFollowup.subtype,
        botId: latestFollowup.botId,
      })
    } catch (err) {
      this.props.onLog(
        `mention poll followup check failed channel=${channel} ts=${threadTs}: ${errorMessage(err)}`,
      )
    }
  }

  private stopTimer(timer: ReturnType<typeof setInterval> | null): void {
    if (timer === null) return
    clearInterval(timer)
  }
}

const sortHistoryByTs = (messages: ReadonlyArray<SlackHistoryMessage>): SlackHistoryMessage[] => {
  return messages.slice().sort((a, b) => Number(a.ts) - Number(b.ts))
}

const latestBotMessageTs = (
  messages: ReadonlyArray<SlackHistoryMessage>,
  botUserId: string,
): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.user === botUserId) return messages[index]!.ts
  }
  return null
}

const dmPollStartOldest = (): number => {
  return (Date.now() - DM_POLL_START_LOOKBACK_MS) / 1000
}

const mentionPollStartOldest = (): number => {
  return (Date.now() - MENTION_POLL_START_LOOKBACK_MS) / 1000
}

const threadTsFromPermalink = (permalink: string | null): string | undefined => {
  if (permalink === null) return undefined
  try {
    return new URL(permalink).searchParams.get("thread_ts") ?? undefined
  } catch {
    const match = /[?&]thread_ts=([0-9.]+)/.exec(permalink)
    return match?.[1]
  }
}

const unrefTimer = (timer: ReturnType<typeof setInterval>): void => {
  const maybeUnref = (timer as { unref?: () => void }).unref
  if (typeof maybeUnref === "function") maybeUnref.call(timer)
}
