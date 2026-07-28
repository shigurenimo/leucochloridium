import { existsSync } from "node:fs"
import { HTTPException } from "hono/http-exception"
import { SqliteEventJournal } from "@/event-journal/sqlite-event-journal"
import { z } from "zod"
import { diagnoseSlackDirectMessage } from "@/actions/slack/diagnose-slack-direct-message"
import { findLatestSlackDirectMessage } from "@/actions/slack/find-latest-slack-direct-message"
import { resolveSlackTokens } from "@/actions/slack/slack-call"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { factory } from "@/cli/cli-factory"
import { resolveProjectArgument } from "@/cli/utils/lookup-config"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"
import type { LeucoEvent } from "@/events/leuco-event-types"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco slack dm / diagnose the latest inbound direct message

usage / leuco slack dm [conversation-id] [--project <p>] [--limit <N>] [--json]

arguments:
  [conversation-id] / optional Slack DM ID (for example D0123ABC)
                      omitted: inspect the newest human message across all DMs

options:
  --project <p> / project whose Slack bot should be inspected; optional inside
                  a project runtime Codex session and required otherwise
  --limit <N> / Slack history messages to inspect (default 50, max 100)
  --json / print JSON instead of YAML

output / daemon and Slack connection state, latest human DM, Socket Mode,
         Codex turn, and bot-reply status

examples:
  leuco slack dm --project cocolococo-hiract
  leuco slack dm D0123ABC --project cocolococo-hiract
  leuco slack dm D0123ABC --project cocolococo-hiract --json

see also: leuco events --type slack.event --project <p> --json`

const directMessageIdSchema = z
  .string()
  .regex(/^D[A-Z0-9]+$/, "conversation ID must be a Slack direct-message ID beginning with D")

const EVENT_TYPES = [
  "slack.connection",
  "slack.event",
  "turn.start",
  "turn.complete",
  "turn.error",
] as const
const EVENT_SCAN_LIMIT = 5_000

export const slackDmHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const rawConversationId = body.args[0]
  const parsedConversationId =
    rawConversationId === undefined ? null : directMessageIdSchema.safeParse(rawConversationId)
  if (parsedConversationId !== null && !parsedConversationId.success) {
    throw new HTTPException(400, {
      message: parsedConversationId.error.issues[0]?.message ?? "invalid DM ID",
    })
  }

  const projectName = flagString(body.flags.project)

  const store = new LeucoProjectStore()
  const project = resolveProjectArgument(c, store, projectName)
  const tokens = resolveSlackTokens({ project })
  const client = new LeucoFetchSlackWebClient({ botToken: tokens.botToken })
  const limit = parseLimit(flagString(body.flags.limit))
  const auth = await client.authTest()
  const selected =
    parsedConversationId === null
      ? await findLatestSlackDirectMessage({
          client,
          botUserId: auth.userId,
          historyLimit: limit,
        })
      : {
          conversationId: parsedConversationId.data,
          messages: (
            await client.conversationsHistory({
              channel: parsedConversationId.data,
              oldest: null,
              inclusive: null,
              limit,
            })
          ).messages,
        }

  const eventLogPath = c.var.daemon.getEventLogPath()
  const eventLogAvailable = existsSync(eventLogPath)
  const events = eventLogAvailable ? queryProjectEvents(eventLogPath, project.name) : []
  const runtime = buildSlackDmRuntimeSummary({
    daemonRunning: c.var.daemon.status().isRunning,
    slackChannel: tokens.connectorName,
    selection: parsedConversationId === null ? "latest" : "explicit",
    events,
  })
  const diagnosis =
    selected === null
      ? {
          conversationId: null,
          message: null,
          socketMode: "unavailable",
          turn: "not_applicable",
          botReply: { status: "not_applicable", ts: null },
          status: "no_user_message",
          error: null,
          nextAction: "No non-bot message was found in any fetched DM history.",
        }
      : diagnoseSlackDirectMessage({
          conversationId: selected.conversationId,
          botUserId: auth.userId,
          messages: selected.messages,
          events,
          eventLogAvailable,
          usesUserToken: tokens.botToken.startsWith("xoxp-"),
        })
  const output = { ...runtime, ...diagnosis }

  return c.text(flagBool(body.flags.json) ? JSON.stringify(output, null, 2) : renderYaml(output))
})

const parseLimit = (raw: string | null): number => {
  if (raw === null) return 50
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new HTTPException(400, {
      message: `--limit must be an integer from 1 to 100 (got "${raw}")`,
    })
  }
  return parsed
}

const queryProjectEvents = (eventLogPath: string, project: string): LeucoEvent[] => {
  const sink = new SqliteEventJournal<LeucoEvent, ["project"]>({
    path: eventLogPath,
    indexes: ["project"],
    extractIndexes: (event) => ({
      project: "project" in event && typeof event.project === "string" ? event.project : null,
    }),
  })

  try {
    return EVENT_TYPES.flatMap((type) =>
      sink.query({
        type,
        where: { project },
        limit: EVENT_SCAN_LIMIT,
        order: "desc",
      }),
    )
      .sort((a, b) => b.seq - a.seq)
      .map((entry) => entry.event)
  } finally {
    sink.close()
  }
}

export const buildSlackDmRuntimeSummary = (props: {
  daemonRunning: boolean
  slackChannel: string
  selection: "latest" | "explicit"
  events: ReadonlyArray<LeucoEvent>
}) => {
  const connection =
    props.events
      .filter(
        (event): event is Extract<LeucoEvent, { type: "slack.connection" }> =>
          event.type === "slack.connection" && event.connector === props.slackChannel,
      )
      .sort((a, b) => b.ts - a.ts)[0] ?? null

  return {
    daemonRunning: props.daemonRunning,
    slackChannel: props.slackChannel,
    slackConnection: connection?.status ?? "unavailable",
    slackConnectionObservedAt: connection?.ts ?? null,
    selection: props.selection,
  }
}
