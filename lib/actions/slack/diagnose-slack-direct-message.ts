import type { SlackHistoryMessage } from "@/channels/slack/leuco-slack-web-client"
import type { LeucoEvent } from "@/events/leuco-event-types"

export type SlackDirectMessageDiagnosis = {
  conversationId: string
  message: { ts: string; user: string | null; threadTs: string } | null
  socketMode: "received" | "missing" | "unavailable"
  turn: "not_started" | "in_progress" | "completed" | "failed" | "not_applicable"
  botReply: { status: "posted" | "missing" | "unavailable" | "not_applicable"; ts: string | null }
  status:
    | "no_user_message"
    | "event_log_unavailable"
    | "socket_event_missing"
    | "turn_not_started"
    | "turn_in_progress"
    | "turn_failed"
    | "reply_missing"
    | "replied"
  error: string | null
  nextAction: string
}

type Props = {
  conversationId: string
  botUserId: string | null
  messages: ReadonlyArray<SlackHistoryMessage>
  events: ReadonlyArray<LeucoEvent>
  eventLogAvailable: boolean
}

/**
 * Correlate one direct-message history slice with leuco's Socket Mode and
 * turn telemetry. All network and SQLite work stays outside this pure helper.
 */
export const diagnoseSlackDirectMessage = (props: Props): SlackDirectMessageDiagnosis => {
  const history = props.messages.slice().sort((a, b) => slackTs(a.ts) - slackTs(b.ts))
  const messageIndex = findLatestHumanMessage(history, props.botUserId)

  if (messageIndex === -1) {
    return {
      conversationId: props.conversationId,
      message: null,
      socketMode: "unavailable",
      turn: "not_applicable",
      botReply: { status: "not_applicable", ts: null },
      status: "no_user_message",
      error: null,
      nextAction: "No non-bot message was found in the fetched DM history.",
    }
  }

  const message = history[messageIndex]!
  const threadTs = message.threadTs ?? message.ts
  const socketEventReceived = hasSocketEvent(props.events, props.conversationId, message.ts)
  const botReply = findBotReply(history, messageIndex, props.botUserId)

  if (botReply !== null) {
    return {
      conversationId: props.conversationId,
      message: { ts: message.ts, user: message.user, threadTs },
      socketMode: socketEventReceived ? "received" : "unavailable",
      turn: "not_applicable",
      botReply: { status: "posted", ts: botReply.ts },
      status: "replied",
      error: null,
      nextAction: "A bot reply is visible after the latest direct message.",
    }
  }

  if (!props.eventLogAvailable) {
    return {
      conversationId: props.conversationId,
      message: { ts: message.ts, user: message.user, threadTs },
      socketMode: "unavailable",
      turn: "not_applicable",
      botReply: { status: "unavailable", ts: null },
      status: "event_log_unavailable",
      error: null,
      nextAction: "Start the daemon once to create events.db, then rerun this diagnosis.",
    }
  }

  if (!socketEventReceived) {
    return {
      conversationId: props.conversationId,
      message: { ts: message.ts, user: message.user, threadTs },
      socketMode: "missing",
      turn: "not_started",
      botReply: { status: "missing", ts: null },
      status: "socket_event_missing",
      error: null,
      nextAction:
        "Slack history has this DM, but Socket Mode did not deliver it. Subscribe to message.im and reinstall the Slack app.",
    }
  }

  const turn = findTurnState(props.events, props.conversationId, threadTs)
  if (turn.status === "not_started") {
    return {
      conversationId: props.conversationId,
      message: { ts: message.ts, user: message.user, threadTs },
      socketMode: "received",
      turn: "not_started",
      botReply: { status: "missing", ts: null },
      status: "turn_not_started",
      error: null,
      nextAction:
        "Socket Mode received the DM, but no Codex turn started. Inspect daemon logs for dispatch failures.",
    }
  }

  if (turn.status === "in_progress") {
    return {
      conversationId: props.conversationId,
      message: { ts: message.ts, user: message.user, threadTs },
      socketMode: "received",
      turn: "in_progress",
      botReply: { status: "missing", ts: null },
      status: "turn_in_progress",
      error: null,
      nextAction:
        "The Codex turn is still running. Query `leuco events --preset turns` again shortly.",
    }
  }

  if (turn.status === "failed") {
    return {
      conversationId: props.conversationId,
      message: { ts: message.ts, user: message.user, threadTs },
      socketMode: "received",
      turn: "failed",
      botReply: { status: "missing", ts: null },
      status: "turn_failed",
      error: turn.error,
      nextAction:
        "The Codex turn failed before a bot reply was visible. Inspect the reported error.",
    }
  }

  return {
    conversationId: props.conversationId,
    message: { ts: message.ts, user: message.user, threadTs },
    socketMode: "received",
    turn: "completed",
    botReply: { status: "missing", ts: null },
    status: "reply_missing",
    error: null,
    nextAction:
      "The turn completed without a visible bot reply. Inspect the turn output and Slack posting path.",
  }
}

const findLatestHumanMessage = (
  messages: ReadonlyArray<SlackHistoryMessage>,
  botUserId: string | null,
): number => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (!isBotMessage(message, botUserId) && message.subtype === null) return index
  }
  return -1
}

const findBotReply = (
  messages: ReadonlyArray<SlackHistoryMessage>,
  messageIndex: number,
  botUserId: string | null,
): SlackHistoryMessage | null => {
  for (let index = messageIndex + 1; index < messages.length; index++) {
    const message = messages[index]!
    if (isBotMessage(message, botUserId)) return message
    if (message.subtype === null) return null
  }
  return null
}

const isBotMessage = (message: SlackHistoryMessage, botUserId: string | null): boolean => {
  return message.botId !== null || (botUserId !== null && message.user === botUserId)
}

const hasSocketEvent = (
  events: ReadonlyArray<LeucoEvent>,
  conversationId: string,
  messageTs: string,
): boolean => {
  return events.some(
    (event) =>
      event.type === "slack.event" &&
      event.channel === conversationId &&
      event.event.kind === "message" &&
      event.event.ts === messageTs,
  )
}

const findTurnState = (
  events: ReadonlyArray<LeucoEvent>,
  conversationId: string,
  threadTs: string,
):
  | { status: "not_started" | "in_progress" | "completed"; error: null }
  | { status: "failed"; error: string } => {
  const suffix = `:${conversationId}:${threadTs}`
  const matching = events
    .filter(
      (event) =>
        (event.type === "turn.start" ||
          event.type === "turn.complete" ||
          event.type === "turn.error") &&
        event.threadKey.endsWith(suffix),
    )
    .sort((a, b) => a.ts - b.ts)

  if (!matching.some((event) => event.type === "turn.start")) {
    return { status: "not_started", error: null }
  }

  const terminal = matching.findLast(
    (event) => event.type === "turn.complete" || event.type === "turn.error",
  )
  if (terminal === undefined) return { status: "in_progress", error: null }
  if (terminal.type === "turn.error") return { status: "failed", error: terminal.error }
  return { status: "completed", error: null }
}

const slackTs = (value: string): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
