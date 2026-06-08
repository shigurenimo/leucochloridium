import { existsSync } from "node:fs"
import { HTTPException } from "hono/http-exception"
import { FunnelLogSqliteSink } from "@interactive-inc/claude-funnel/logger"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import type { LeucoEvent } from "@/events/leuco-event-types"

const help = `leuco events / query daemon event log

usage / leuco events [--type <type>] [--project <name>] [--limit <N>] [--json]

options:
  --type <type>     filter by event type (e.g. turn.complete, log)
  --project <name>  filter by project name
  --limit <N>       number of entries (default: 20, newest first)
  --json            output raw JSON lines instead of formatted text

event types:
  log  tenant.started  tenant.stopped  engine.reconcile
  engine.reconcile.failed  slack.event  turn.start  turn.complete
  turn.error  codex.notification  schedule.fired`

const formatEvent = (event: LeucoEvent): string => {
  const date = new Date(event.ts)
  const time = date.toLocaleTimeString("en-GB", { hour12: false })

  if (event.type === "log") {
    return `${time}  ${event.level.toUpperCase().padEnd(5)}  ${event.line}`
  }

  if (event.type === "turn.start") {
    return `${time}  TURN   ${event.project}  start  ${event.threadKey}  ${event.input.slice(0, 80)}`
  }

  if (event.type === "turn.complete") {
    return `${time}  TURN   ${event.project}  done   ${event.threadKey}  ${event.reply.slice(0, 80)}`
  }

  if (event.type === "turn.error") {
    return `${time}  TURN   ${event.project}  error  ${event.threadKey}  ${event.error}`
  }

  if (event.type === "tenant.started" || event.type === "tenant.stopped") {
    return `${time}  ${event.type.padEnd(20)}  ${event.project}`
  }

  if (event.type === "engine.reconcile") {
    return `${time}  engine.reconcile     added=[${event.added.join(",")}] removed=[${event.removed.join(",")}]`
  }

  if (event.type === "schedule.fired") {
    return `${time}  schedule.fired       ${event.project}  ${event.entryName}  ${event.kind}`
  }

  return `${time}  ${event.type}`
}

export const eventsHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const eventLogPath = c.var.daemon.getEventLogPath()

  if (!existsSync(eventLogPath)) {
    throw new HTTPException(404, { message: `no event log yet: ${eventLogPath}` })
  }

  const sink = new FunnelLogSqliteSink<LeucoEvent, ["project"]>({
    path: eventLogPath,
    indexes: ["project"],
    extractIndexes: (event) => ({
      project: "project" in event && typeof event.project === "string" ? event.project : null,
    }),
  })

  const limit = typeof body.flags.limit === "string" ? Math.max(1, Number(body.flags.limit)) : 20
  const typeFilter = typeof body.flags.type === "string" ? body.flags.type : undefined
  const projectFilter = typeof body.flags.project === "string" ? body.flags.project : undefined
  const asJson = flagBool(body.flags.json)

  const entries = sink.query({
    type: typeFilter,
    where: projectFilter ? { project: projectFilter } : undefined,
    limit,
    order: "desc",
  })

  sink.close()

  if (entries.length === 0) {
    return c.text("no events")
  }

  if (asJson) {
    const lines = entries.map((entry) => JSON.stringify(entry.event))
    return c.text(lines.join("\n"))
  }

  const lines = entries.map((entry) => formatEvent(entry.event))
  return c.text(lines.join("\n"))
})
