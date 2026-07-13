import { existsSync } from "node:fs"
import { HTTPException } from "hono/http-exception"
import { FunnelLogSqliteSink } from "@interactive-inc/claude-funnel/logger"
import { z } from "zod"
import { diagnoseSlackDirectMessage } from "@/actions/slack/diagnose-slack-direct-message"
import { resolveSlackTokens } from "@/actions/slack/slack-call"
import { LeucoFetchSlackWebClient } from "@/channels/slack/leuco-fetch-slack-web-client"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"
import type { LeucoEvent } from "@/events/leuco-event-types"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco slack dm / diagnose the latest inbound direct message

usage / leuco slack dm <conversation-id> --project <p> [--limit <N>] [--json]

arguments:
  <conversation-id> / Slack direct-message ID (for example D0123ABC)

options:
  --project <p> / project whose Slack bot should be inspected
  --limit <N> / Slack history messages to inspect (default 50, max 100)
  --json / print JSON instead of YAML

output / latest human DM plus Socket Mode, Codex turn, and bot-reply status

examples:
  leuco slack dm D0123ABC --project cocolococo-hiract
  leuco slack dm D0123ABC --project cocolococo-hiract --json

see also: leuco events --type slack.event --project <p> --json`

const directMessageIdSchema = z
  .string()
  .regex(/^D[A-Z0-9]+$/, "conversation ID must be a Slack direct-message ID beginning with D")

const EVENT_TYPES = ["slack.event", "turn.start", "turn.complete", "turn.error"] as const
const EVENT_SCAN_LIMIT = 5_000

export const slackDmHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const rawConversationId = body.args[0]
  if (rawConversationId === undefined) {
    throw new HTTPException(400, { message: "usage: leuco slack dm <D...> --project <p>" })
  }
  const conversationId = directMessageIdSchema.safeParse(rawConversationId)
  if (!conversationId.success) {
    throw new HTTPException(400, {
      message: conversationId.error.issues[0]?.message ?? "invalid DM ID",
    })
  }

  const projectName = flagString(body.flags.project)
  if (projectName === null) throw new HTTPException(400, { message: "--project is required" })

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  const tokens = resolveSlackTokens({ project })
  const client = new LeucoFetchSlackWebClient({ botToken: tokens.botToken })
  const limit = parseLimit(flagString(body.flags.limit))
  const auth = await client.authTest()
  const history = await client.conversationsHistory({
    channel: conversationId.data,
    oldest: null,
    inclusive: null,
    limit,
  })

  const eventLogPath = c.var.daemon.getEventLogPath()
  const eventLogAvailable = existsSync(eventLogPath)
  const events = eventLogAvailable ? queryProjectEvents(eventLogPath, project.name) : []
  const diagnosis = diagnoseSlackDirectMessage({
    conversationId: conversationId.data,
    botUserId: auth.userId,
    messages: history.messages,
    events,
    eventLogAvailable,
  })

  return c.text(
    flagBool(body.flags.json) ? JSON.stringify(diagnosis, null, 2) : renderYaml(diagnosis),
  )
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
  const sink = new FunnelLogSqliteSink<LeucoEvent, ["project"]>({
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
