/** Domain-level Slack event envelopes passed to the bridge. */

export type SlackMessageEvent = {
  kind: "message"
  channel: string
  user: string
  /** Raw text exactly as Slack delivered it (mention markup intact). */
  rawText: string
  /** Mention markup stripped, useful when the bot wants the bare prompt. */
  text: string
  /** Slack thread anchor — `thread_ts` when in a thread, otherwise the parent message `ts`. */
  threadTs: string
  /** Original message `ts` (for distinguishing first vs follow-up). */
  ts: string
  /** True when this is a top-level message that opens a new thread. */
  isThreadRoot: boolean
  /** True when the bot's user was @-mentioned in `rawText`. */
  mentioned: boolean
  /** Whether this was delivered via `app_mention` or the generic `message` event. */
  source: "app_mention" | "message"
}

export type SlackReactionEvent = {
  kind: "reaction_added" | "reaction_removed"
  channel: string
  /** User who added or removed the reaction. */
  user: string
  emoji: string
  /** ts of the message the reaction is on. */
  targetTs: string
  /** Author of the message the reaction is on (may be undefined for files etc.). */
  targetUser: string | null
}

export type SlackEvent = SlackMessageEvent | SlackReactionEvent

/** Legacy alias — message-only listeners still consume `SlackMessage`. */
export type SlackMessage = SlackMessageEvent

export type SlackReply = {
  channel: string
  threadTs: string
  text: string
}
