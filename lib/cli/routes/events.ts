import { existsSync } from "node:fs"
import { HTTPException } from "hono/http-exception"
import { FunnelLogSqliteSink } from "@interactive-inc/claude-funnel/logger"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import type { LeucoEvent } from "@/events/leuco-event-types"

const PRESETS: Record<string, { types: string[]; description: string }> = {
  turns: {
    types: ["turn.start", "turn.complete", "turn.error"],
    description: "codex turn lifecycle (start / complete / error)",
  },
  errors: {
    types: ["turn.error", "engine.reconcile.failed", "slack.error"],
    description: "turn errors, reconcile failures, slack auth/connection errors",
  },
  lifecycle: {
    types: ["tenant.started", "tenant.stopped", "engine.reconcile", "slack.connection"],
    description: "tenant start/stop, engine reconcile, slack connection transitions",
  },
  schedule: {
    types: ["schedule.fired"],
    description: "cron and one-shot schedule firings",
  },
}

const presetList = Object.entries(PRESETS)
  .map(([name, preset]) => `  ${name.padEnd(12)} ${preset.description}`)
  .join("\n")

const help = `leuco events / query the daemon structured event log

usage / leuco events [--preset <name>] [--type <type>] [--project <name>]
                     [--limit <N>] [--json]

options:
  --preset <name>   run a named preset (see below)
  --type <type>     filter by event type (e.g. turn.complete, log)
  --project <name>  filter by project name
  --limit <N>       number of entries (default: 20, newest first)
  --json            output raw JSON lines instead of formatted text

presets (--preset <name>):
${presetList}

event types:
  log  tenant.started  tenant.stopped  engine.reconcile
  engine.reconcile.failed  slack.event  slack.connection  slack.error
  turn.start  turn.complete  turn.error  codex.notification  schedule.fired

output / one line per event, newest first. --json outputs raw JSON objects.

examples:
  leuco events                              last 20 events
  leuco events --preset turns               recent codex turns
  leuco events --preset errors              turn errors + reconcile failures
  leuco events --preset errors --json       same, as JSON (pipe to jq)
  leuco events --type turn.complete         filter by specific type
  leuco events --project myapp --limit 50   project-scoped, more rows

see also: leuco status, leuco logs -f`

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

  if (event.type === "engine.reconcile.failed") {
    return `${time}  engine.reconcile.failed  ${event.reason}`
  }

  if (event.type === "schedule.fired") {
    return `${time}  schedule.fired       ${event.project}  ${event.entryName}  ${event.kind}`
  }

  if (event.type === "codex.notification") {
    return `${time}  codex.notification   ${event.project}  ${event.method}`
  }

  if (event.type === "slack.event") {
    return `${time}  slack.event          ${event.project}  ${event.channel}`
  }

  if (event.type === "slack.connection") {
    return `${time}  slack.connection     ${event.project}  ${event.channel}  ${event.status}`
  }

  if (event.type === "slack.error") {
    const errSuffix = event.error !== null ? `  err=${event.error}` : ""
    return `${time}  slack.error          ${event.project}  ${event.channel}  ${event.level}  ${event.action}: ${event.message}${errSuffix}`
  }

  return `${time}  unknown`
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

  const limit = parseLimitFlag(body.flags.limit)
  const projectFilter = typeof body.flags.project === "string" ? body.flags.project : undefined
  const asJson = flagBool(body.flags.json)

  const presetName = typeof body.flags.preset === "string" ? body.flags.preset : null
  const typeFlag = typeof body.flags.type === "string" ? body.flags.type : null

  if (presetName !== null && !(presetName in PRESETS)) {
    throw new HTTPException(400, {
      message: `unknown preset: ${presetName}\n\navailable: ${Object.keys(PRESETS).join(", ")}`,
    })
  }

  const presetTypes = presetName !== null ? PRESETS[presetName]!.types : null
  const filterTypes = typeFlag !== null ? [typeFlag] : presetTypes

  let allEntries: Awaited<ReturnType<typeof sink.query>>
  try {
    allEntries =
      filterTypes !== null
        ? filterTypes.flatMap((type) =>
            sink.query({
              type,
              where: projectFilter ? { project: projectFilter } : undefined,
              limit,
              order: "desc",
            }),
          )
        : sink.query({
            where: projectFilter ? { project: projectFilter } : undefined,
            limit,
            order: "desc",
          })
  } finally {
    sink.close()
  }

  const sorted = allEntries.sort((a, b) => b.seq - a.seq).slice(0, limit)

  if (sorted.length === 0) {
    return c.text("no events")
  }

  if (asJson) {
    const lines = sorted.map((entry) => JSON.stringify(entry.event))
    return c.text(lines.join("\n"))
  }

  const lines = sorted.map((entry) => formatEvent(entry.event))
  return c.text(lines.join("\n"))
})

const parseLimitFlag = (raw: string | boolean | undefined): number => {
  if (typeof raw !== "string") return 20

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HTTPException(400, { message: `--limit must be a positive integer (got "${raw}")` })
  }
  return parsed
}
