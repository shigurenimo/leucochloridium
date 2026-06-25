import { App, LogLevel } from "@slack/bolt"
import {
  LeucoSlackEventProcessor,
  slackTextMentionsUser,
} from "@/channels/slack/slack-event-processor"
import { slackAuthTestSchema } from "@/channels/slack/slack-schemas"
import type { SlackEvent } from "@/channels/slack/slack-types"
import { errorMessage } from "@/error-message"

type EventHandler = (event: SlackEvent) => void | Promise<void>

type Props = {
  botToken: string
  appToken: string
  label?: string
  onLog?: (line: string) => void
}

type SocketLikeEmitter = {
  on: (event: string, listener: (...args: unknown[]) => void) => void
}

type AppWithSocketReceiver = {
  receiver?: {
    client?: SocketLikeEmitter
  } | null
}

const SOCKET_RESTART_GRACE_MS = 90_000
const SOCKET_CHURN_WINDOW_MS = 60_000
const SOCKET_CHURN_THRESHOLD = 4
const SOCKET_EVENT_START_GRACE_MS = 30_000
const DM_POLL_INTERVAL_MS = 15_000
const DM_POLL_START_LOOKBACK_MS = 60_000
const DM_POLL_HISTORY_LIMIT = 20
const MENTION_POLL_INTERVAL_MS = 30_000
const MENTION_POLL_START_LOOKBACK_MS = 30 * 60_000
const MENTION_POLL_SEARCH_COUNT = 50
const MENTION_POLL_BOOTSTRAP_UNANSWERED_LIMIT = 3
const OWN_REPLY_POLL_INTERVAL_MS = 30_000
const OWN_REPLY_POLL_SEARCH_COUNT = 50
const ACTIVE_THREAD_CAPACITY = 500

/**
 * Slack Socket Mode listener. Owns the bolt `App` lifecycle; delegates all
 * decision logic (schema check, dedup, self filter) to
 * `LeucoSlackEventProcessor`. Forwards messages and reaction events to the
 * bridge as a `SlackEvent` union — the agent decides whether to respond.
 */
export class LeucoSlackListener {
  private readonly app: App
  private readonly label: string
  private readonly usesUserToken: boolean
  private readonly socketEventOldest = socketEventStartOldest()
  private readonly onLog: ((line: string) => void) | undefined
  private handler: EventHandler | null = null
  // Wire the processor at construction so events arriving in the
  // `app.start()`→`fetchBotUserId()` window aren't silently dropped. The
  // botUserId starts null (causing self/bot filters to skip those events
  // until known) and is upgraded once auth.test resolves.
  private processor: LeucoSlackEventProcessor
  private botUserId: string | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private dmPollTimer: ReturnType<typeof setInterval> | null = null
  private mentionPollTimer: ReturnType<typeof setInterval> | null = null
  private ownReplyPollTimer: ReturnType<typeof setInterval> | null = null
  private dmPollInflight = false
  private mentionPollInflight = false
  private ownReplyPollInflight = false
  private dmPollOldestByChannel = new Map<string, number>()
  private mentionPollOldest = mentionPollStartOldest()
  private mentionPollBootstrapped = false
  private activeThreads = new Map<string, number>()
  private problemTimestamps: number[] = []
  private restarting = false
  private stopping = false

  constructor(props: Props) {
    this.label = props.label ?? "slack"
    this.usesUserToken = props.botToken.startsWith("xoxp-")
    this.onLog = props.onLog
    this.app = new App({
      token: props.botToken,
      appToken: props.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    })
    this.processor = new LeucoSlackEventProcessor({ botUserId: null })
    this.bindEvents()
    this.bindSocketLifecycle()
  }

  onEvent(handler: EventHandler): void {
    this.handler = handler
  }

  async start(): Promise<{ botUserId: string | null }> {
    await this.app.start()
    this.botUserId = await this.fetchBotUserId()
    // Upgrade the processor in place — mutating preserves the LRU dedup
    // window that may already hold ids from events that arrived during the
    // `app.start()` → `auth.test` race. Rebuilding would drop those keys and
    // let an early redelivery dispatch twice.
    this.processor.setBotUserId(this.botUserId)
    this.startDmPoller()
    this.startMentionPoller()
    this.startOwnReplyPoller()
    return { botUserId: this.botUserId }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearRestartTimer()
    this.stopDmPoller()
    this.stopMentionPoller()
    this.stopOwnReplyPoller()
    await this.app.stop()
  }

  private async fetchBotUserId(): Promise<string | null> {
    try {
      const auth = await this.app.client.auth.test()
      const parsed = slackAuthTestSchema.safeParse(auth)
      return parsed.success ? (parsed.data.user_id ?? null) : null
    } catch (err) {
      this.log(`auth.test failed: ${errorMessage(err)}`)
      return null
    }
  }

  private bindEvents(): void {
    this.app.event("app_mention", async (args) => {
      if (this.shouldDropStaleSocketEvent(args.event)) return
      await this.dispatchResult(this.processor.processAppMention(args.event))
    })

    this.app.message(async (args) => {
      if (this.shouldDropStaleSocketEvent(args.message)) return
      this.recordActiveThreadFromRawMessage(args.message)
      await this.dispatchResult(
        this.withActiveThreadContext(this.processor.processMessage(args.message)),
      )
    })

    this.app.event("reaction_added", async (args) => {
      if (this.shouldDropStaleSocketEvent(args.event)) return
      await this.dispatchResult(this.processor.processReaction(args.event))
    })

    this.app.event("reaction_removed", async (args) => {
      if (this.shouldDropStaleSocketEvent(args.event)) return
      await this.dispatchResult(this.processor.processReaction(args.event))
    })

    this.app.error(async (err) => {
      this.log(`bolt error: ${errorMessage(err)}`)
    })
  }

  private shouldDropStaleSocketEvent(event: unknown): boolean {
    const ts = slackEventTimestamp(event)
    if (ts === null || ts >= this.socketEventOldest) return false
    this.log(
      `skip stale socket event ts=${ts.toFixed(6)} oldest=${this.socketEventOldest.toFixed(6)}`,
    )
    return true
  }

  private bindSocketLifecycle(): void {
    const client = (this.app as unknown as AppWithSocketReceiver).receiver?.client

    if (!client || typeof client.on !== "function") {
      this.log("socket lifecycle unavailable; watchdog disabled")
      return
    }

    client.on("connected", () => {
      this.log("socket connected")
      this.clearRestartTimer()
      this.problemTimestamps = []
    })

    client.on("disconnected", () => {
      this.log("socket disconnected")
      this.scheduleSocketRestart("disconnected")
    })

    client.on("reconnecting", () => {
      this.log("socket reconnecting")
      this.scheduleSocketRestart("reconnecting")
    })

    client.on("close", (...args: unknown[]) => {
      const code = typeof args[0] === "number" ? ` code=${args[0]}` : ""
      this.log(`socket closed${code}`)
      this.scheduleSocketRestart("closed")
    })

    client.on("error", (err: unknown) => {
      this.log(`socket error: ${errorMessage(err)}`)
      this.scheduleSocketRestart("error")
    })
  }

  private scheduleSocketRestart(reason: string): void {
    if (this.stopping || this.restartTimer !== null) return

    if (this.recordSocketProblem()) {
      this.log(
        `socket churn detected (${SOCKET_CHURN_THRESHOLD} events/${SOCKET_CHURN_WINDOW_MS / 1000}s); rebuilding now`,
      )
      void this.restartSocketApp(`churn:${reason}`)
      return
    }

    this.log(
      `socket unhealthy (${reason}); rebuilding if not connected after ${SOCKET_RESTART_GRACE_MS / 1000}s`,
    )
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.restartSocketApp(reason)
    }, SOCKET_RESTART_GRACE_MS)
    unrefTimer(this.restartTimer)
  }

  private clearRestartTimer(): void {
    if (this.restartTimer === null) return
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private async restartSocketApp(reason: string): Promise<void> {
    if (this.stopping || this.restarting) return

    this.restarting = true
    this.clearRestartTimer()
    this.log(`socket watchdog rebuilding Socket Mode app (${reason})`)
    try {
      await this.app.stop().catch((err: unknown) => {
        this.log(`socket watchdog stop failed: ${errorMessage(err)}`)
      })
      await this.app.start()
      this.botUserId = await this.fetchBotUserId()
      this.processor.setBotUserId(this.botUserId)
      this.startDmPoller()
      this.startMentionPoller()
      this.startOwnReplyPoller()
      const who = this.botUserId ? `<@${this.botUserId}>` : "(bot)"
      this.log(`socket watchdog ready (bot=${who})`)
    } catch (err) {
      this.log(`socket watchdog restart failed: ${errorMessage(err)}`)
      this.scheduleSocketRestart("restart failed")
    } finally {
      this.restarting = false
    }
  }

  private recordSocketProblem(): boolean {
    const now = Date.now()
    const since = now - SOCKET_CHURN_WINDOW_MS
    this.problemTimestamps = this.problemTimestamps.filter((ts) => ts >= since)
    this.problemTimestamps.push(now)
    return this.problemTimestamps.length >= SOCKET_CHURN_THRESHOLD
  }

  private startDmPoller(): void {
    if (!this.usesUserToken) return
    if (this.dmPollTimer !== null) return
    if (this.botUserId === null) return

    this.log("dm poller started for xoxp token")
    this.dmPollTimer = setInterval(() => {
      void this.pollDms()
    }, DM_POLL_INTERVAL_MS)
    unrefTimer(this.dmPollTimer)
    void this.pollDms()
  }

  private stopDmPoller(): void {
    if (this.dmPollTimer === null) return
    clearInterval(this.dmPollTimer)
    this.dmPollTimer = null
  }

  private startMentionPoller(): void {
    if (!this.usesUserToken) return
    if (this.mentionPollTimer !== null) return
    if (this.botUserId === null) return

    this.log("mention poller started for xoxp token")
    this.mentionPollTimer = setInterval(() => {
      void this.pollMentions()
    }, MENTION_POLL_INTERVAL_MS)
    unrefTimer(this.mentionPollTimer)
    void this.pollMentions()
  }

  private stopMentionPoller(): void {
    if (this.mentionPollTimer === null) return
    clearInterval(this.mentionPollTimer)
    this.mentionPollTimer = null
  }

  private startOwnReplyPoller(): void {
    if (!this.usesUserToken) return
    if (this.ownReplyPollTimer !== null) return
    if (this.botUserId === null) return

    this.log("own reply poller started for xoxp token")
    this.ownReplyPollTimer = setInterval(() => {
      void this.pollOwnReplies()
    }, OWN_REPLY_POLL_INTERVAL_MS)
    unrefTimer(this.ownReplyPollTimer)
    void this.pollOwnReplies()
  }

  private stopOwnReplyPoller(): void {
    if (this.ownReplyPollTimer === null) return
    clearInterval(this.ownReplyPollTimer)
    this.ownReplyPollTimer = null
  }

  private async pollDms(): Promise<void> {
    if (this.stopping || this.dmPollInflight) return

    this.dmPollInflight = true
    try {
      const channels = await this.listImChannels()
      for (const channel of channels) {
        await this.pollDmChannel(channel)
      }
    } catch (err) {
      this.log(`dm poll failed: ${errorMessage(err)}`)
    } finally {
      this.dmPollInflight = false
    }
  }

  private async listImChannels(): Promise<string[]> {
    const result = await this.app.client.conversations.list({
      types: "im",
      limit: 200,
    })
    const channels = (result as SlackConversationsListResult).channels ?? []
    return channels.flatMap((channel) =>
      typeof channel.id === "string" && channel.is_im === true ? [channel.id] : [],
    )
  }

  private async pollDmChannel(channel: string): Promise<void> {
    const oldest = this.dmPollOldestByChannel.get(channel) ?? dmPollStartOldest()
    const result = await this.app.client.conversations.history({
      channel,
      oldest: oldest.toFixed(6),
      inclusive: false,
      limit: DM_POLL_HISTORY_LIMIT,
    })
    const messages = ((result as SlackConversationHistoryResult).messages ?? [])
      .filter(isSlackHistoryMessage)
      .sort((a, b) => Number(a.ts) - Number(b.ts))

    for (const message of messages) {
      const tsNumber = Number(message.ts)
      if (Number.isFinite(tsNumber)) {
        this.dmPollOldestByChannel.set(channel, Math.max(oldest, tsNumber))
      }
      await this.dispatchResult(this.processor.processMessage({
        type: "message",
        channel,
        user: message.user,
        text: message.text,
        ts: message.ts,
        thread_ts: message.thread_ts,
        subtype: message.subtype,
        bot_id: message.bot_id,
      }))
    }
  }

  private async pollMentions(): Promise<void> {
    if (this.stopping || this.mentionPollInflight || this.botUserId === null) return

    this.mentionPollInflight = true
    try {
      const result = await this.app.client.search.messages({
        query: `<@${this.botUserId}>`,
        sort: "timestamp",
        sort_dir: "desc",
        count: MENTION_POLL_SEARCH_COUNT,
      })
      const matches = ((result as SlackSearchMessagesResult).messages?.matches ?? [])
        .filter(isSlackSearchMessageMatch)
        .filter((match) => slackTextMentionsUser(match.text ?? "", this.botUserId))
        .filter((match) => {
          const ts = Number(match.ts)
          return Number.isFinite(ts) && ts > this.mentionPollOldest
        })
        .sort((a, b) => Number(b.ts) - Number(a.ts))

      const checkedFollowupThreads = new Set<string>()
      const unansweredMatches: SlackSearchMessageMatch[] = []
      let newestSeen = this.mentionPollOldest
      for (const match of matches) {
        const channel = match.channel.id
        const tsNumber = Number(match.ts)
        if (Number.isFinite(tsNumber)) newestSeen = Math.max(newestSeen, tsNumber)
        const threadTs = threadTsFromPermalink(match.permalink) ?? match.ts
        if (await this.hasBotReplyAfter(channel, threadTs, match.ts)) {
          this.log(`mention poll skip answered channel=${channel} ts=${match.ts}`)
          await this.dispatchLatestThreadFollowup(channel, threadTs, checkedFollowupThreads)
          continue
        }
        unansweredMatches.push(match)
      }

      let unansweredDispatched = 0
      for (const match of unansweredMatches) {
        const channel = match.channel.id
        const threadTs = threadTsFromPermalink(match.permalink) ?? match.ts
        if (
          !this.mentionPollBootstrapped
          && unansweredDispatched >= MENTION_POLL_BOOTSTRAP_UNANSWERED_LIMIT
        ) {
          this.log(`mention poll bootstrap skip old unanswered channel=${channel} ts=${match.ts}`)
          continue
        }
        unansweredDispatched += 1
        await this.dispatchResult(this.processor.processMessage({
          type: "message",
          channel,
          user: match.user,
          text: match.text,
          ts: match.ts,
          thread_ts: threadTs,
        }))
      }
      this.mentionPollOldest = newestSeen
      this.mentionPollBootstrapped = true
    } catch (err) {
      this.log(`mention poll failed: ${errorMessage(err)}`)
    } finally {
      this.mentionPollInflight = false
    }
  }

  private async pollOwnReplies(): Promise<void> {
    if (this.stopping || this.ownReplyPollInflight || this.botUserId === null) return

    this.ownReplyPollInflight = true
    try {
      const result = await this.app.client.search.messages({
        query: `from:<@${this.botUserId}>`,
        sort: "timestamp",
        sort_dir: "desc",
        count: OWN_REPLY_POLL_SEARCH_COUNT,
      })
      const checkedThreads = new Set<string>()
      const matches = ((result as SlackSearchMessagesResult).messages?.matches ?? [])
        .filter(isSlackSearchMessageMatch)
        .filter((match) => match.user === this.botUserId)

      for (const match of matches) {
        const channel = match.channel.id
        const threadTs = threadTsFromPermalink(match.permalink) ?? match.ts
        this.rememberActiveThread(channel, threadTs)
        await this.dispatchLatestThreadFollowup(channel, threadTs, checkedThreads)
      }
    } catch (err) {
      this.log(`own reply poll failed: ${errorMessage(err)}`)
    } finally {
      this.ownReplyPollInflight = false
    }
  }

  private async hasBotReplyAfter(
    channel: string,
    threadTs: string,
    messageTs: string,
  ): Promise<boolean> {
    if (this.botUserId === null) return false
    try {
      const result = await this.app.client.conversations.replies({
        channel,
        ts: threadTs,
        oldest: messageTs,
        inclusive: false,
        limit: 100,
      })
      const messages = ((result as SlackConversationHistoryResult).messages ?? [])
        .filter(isSlackHistoryMessage)
      return messages.some((message) => message.user === this.botUserId)
    } catch (err) {
      this.log(`mention poll reply check failed channel=${channel} ts=${messageTs}: ${errorMessage(err)}`)
      return false
    }
  }

  private async dispatchLatestThreadFollowup(
    channel: string,
    threadTs: string,
    checkedThreads: Set<string>,
  ): Promise<void> {
    const key = `${channel}:${threadTs}`
    if (checkedThreads.has(key) || this.botUserId === null) return
    checkedThreads.add(key)

    try {
      const result = await this.app.client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 100,
      })
      const messages = ((result as SlackConversationHistoryResult).messages ?? [])
        .filter(isSlackHistoryMessage)
        .sort((a, b) => Number(a.ts) - Number(b.ts))
      const lastBotTs = latestBotMessageTs(messages, this.botUserId)
      if (lastBotTs === null) return
      this.rememberActiveThread(channel, threadTs)
      const latestFollowup = messages
        .filter((message) => Number(message.ts) > Number(lastBotTs))
        .filter((message) => message.user !== this.botUserId)
        .filter((message) => message.bot_id === undefined)
        .filter((message) => message.subtype === undefined)
        .at(-1)
      if (!latestFollowup) return

      this.log(`mention poll dispatch thread followup channel=${channel} ts=${latestFollowup.ts}`)
      await this.dispatchResult(
        this.withActiveThreadContext(this.processor.processMessage({
          type: "message",
          channel,
          user: latestFollowup.user,
          text: latestFollowup.text,
          ts: latestFollowup.ts,
          thread_ts: latestFollowup.thread_ts ?? threadTs,
          subtype: latestFollowup.subtype,
          bot_id: latestFollowup.bot_id,
        })),
      )
    } catch (err) {
      this.log(`mention poll followup check failed channel=${channel} ts=${threadTs}: ${errorMessage(err)}`)
    }
  }

  private recordActiveThreadFromRawMessage(message: unknown): void {
    if (this.botUserId === null) return
    if (typeof message !== "object" || message === null) return
    const data = message as { channel?: unknown; user?: unknown; ts?: unknown; thread_ts?: unknown }
    if (data.user !== this.botUserId) return
    if (typeof data.channel !== "string" || typeof data.ts !== "string") return
    const threadTs = typeof data.thread_ts === "string" ? data.thread_ts : data.ts
    this.rememberActiveThread(data.channel, threadTs)
  }

  private withActiveThreadContext(
    result: ReturnType<LeucoSlackEventProcessor["processMessage"]>,
  ): ReturnType<LeucoSlackEventProcessor["processMessage"]> {
    if (result.skip || result.event.kind !== "message") return result
    if (!this.activeThreads.has(activeThreadKey(result.event.channel, result.event.threadTs))) {
      return result
    }
    return {
      skip: false,
      event: { ...result.event, mentioned: true },
    }
  }

  private rememberActiveThread(channel: string, threadTs: string): void {
    const key = activeThreadKey(channel, threadTs)
    this.activeThreads.delete(key)
    this.activeThreads.set(key, Date.now())
    while (this.activeThreads.size > ACTIVE_THREAD_CAPACITY) {
      const oldest = this.activeThreads.keys().next().value
      if (typeof oldest !== "string") break
      this.activeThreads.delete(oldest)
    }
  }

  private async dispatchResult(
    result: ReturnType<LeucoSlackEventProcessor["processMessage"]>,
  ): Promise<void> {
    if (result.skip) {
      this.log(result.reason)
      return
    }
    if (!this.handler) {
      this.log("no handler registered; dropping event")
      return
    }
    this.log(formatDispatch(result.event))
    await this.handler(result.event)
  }

  private log(line: string): void {
    if (this.onLog) this.onLog(`[slack:${this.label}] ${line}`)
  }
}

const formatDispatch = (event: SlackEvent): string => {
  if (event.kind === "message") {
    return `dispatch ${event.source} channel=${event.channel} ts=${event.ts}${event.mentioned ? " mentioned" : ""}`
  }
  return `dispatch ${event.kind} channel=${event.channel} target_ts=${event.targetTs} :${event.emoji}: by=${event.user}`
}

const activeThreadKey = (channel: string, threadTs: string): string => `${channel}:${threadTs}`

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  const maybeUnref = (timer as { unref?: () => void }).unref
  if (typeof maybeUnref === "function") maybeUnref.call(timer)
}

const dmPollStartOldest = (): number => {
  return (Date.now() - DM_POLL_START_LOOKBACK_MS) / 1000
}

const socketEventStartOldest = (): number => {
  return (Date.now() - SOCKET_EVENT_START_GRACE_MS) / 1000
}

const slackEventTimestamp = (event: unknown): number | null => {
  if (typeof event !== "object" || event === null) return null
  const raw = (event as { ts?: unknown; event_ts?: unknown }).ts
    ?? (event as { event_ts?: unknown }).event_ts
  if (typeof raw !== "string" && typeof raw !== "number") return null
  const ts = Number(raw)
  return Number.isFinite(ts) ? ts : null
}

type SlackConversationsListResult = {
  channels?: Array<{ id?: unknown; is_im?: unknown }>
}

type SlackConversationHistoryResult = {
  messages?: unknown[]
}

type SlackSearchMessagesResult = {
  messages?: {
    matches?: unknown[]
  }
}

type SlackHistoryMessage = {
  user?: string
  text?: string
  ts: string
  thread_ts?: string
  subtype?: string
  bot_id?: string
}

const isSlackHistoryMessage = (message: unknown): message is SlackHistoryMessage => {
  if (typeof message !== "object" || message === null) return false
  const ts = (message as { ts?: unknown }).ts
  return typeof ts === "string"
}

const latestBotMessageTs = (
  messages: SlackHistoryMessage[],
  botUserId: string,
): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.user === botUserId) return messages[index]!.ts
  }
  return null
}

type SlackSearchMessageMatch = {
  channel: { id: string }
  user?: string
  text?: string
  ts: string
  permalink?: string
}

const isSlackSearchMessageMatch = (match: unknown): match is SlackSearchMessageMatch => {
  if (typeof match !== "object" || match === null) return false
  const channel = (match as { channel?: unknown }).channel
  const ts = (match as { ts?: unknown }).ts
  if (typeof channel !== "object" || channel === null) return false
  const channelId = (channel as { id?: unknown }).id
  return typeof channelId === "string" && typeof ts === "string"
}

const mentionPollStartOldest = (): number => {
  return (Date.now() - MENTION_POLL_START_LOOKBACK_MS) / 1000
}

const threadTsFromPermalink = (permalink: string | undefined): string | undefined => {
  if (permalink === undefined) return undefined
  try {
    return new URL(permalink).searchParams.get("thread_ts") ?? undefined
  } catch {
    const match = /[?&]thread_ts=([0-9.]+)/.exec(permalink)
    return match?.[1]
  }
}
