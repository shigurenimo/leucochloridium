import type { EventLogEntry } from "@/event-log/event-log-entry"
import type { LeucoEventQuery } from "@/events/leuco-event-query"
import type { LeucoEvent } from "@/events/leuco-event-types"

export function queryLeucoEventEntries(
  entries: ReadonlyArray<EventLogEntry<LeucoEvent>>,
  query: LeucoEventQuery,
): ReadonlyArray<EventLogEntry<LeucoEvent>> {
  if (query.limit === 0) return []

  const matching = entries.filter((entry) => matches(entry, query))
  const limit = query.limit ?? 1000
  const selected = query.order === "desc" ? matching.slice(-limit) : matching.slice(0, limit)

  return selected
}

function matches(entry: EventLogEntry<LeucoEvent>, query: LeucoEventQuery): boolean {
  if (query.summary && entry.event.type === "codex.notification") return false
  if (query.summary && entry.event.type === "log" && entry.event.level === "info") return false
  if (query.requestId !== undefined && entry.event.requestId !== query.requestId) return false
  if (query.sinceTs !== undefined && entry.ts < query.sinceTs) return false
  if (entry.seq <= (query.sinceSeq ?? 0)) return false
  if (query.type !== undefined && entry.event.type !== query.type) return false
  return true
}
