import type { EventLogEntry } from "@/event-log/event-log-entry"
import type { LeucoEventQuery } from "@/events/leuco-event-query"
import type { LeucoEvent } from "@/events/leuco-event-types"

export function queryLeucoEventEntries(
  entries: ReadonlyArray<EventLogEntry<LeucoEvent>>,
  query: LeucoEventQuery,
): ReadonlyArray<EventLogEntry<LeucoEvent>> {
  const matching = entries.filter((entry) => matches(entry, query))
  const limit = query.limit ?? 1000
  const selected = query.order === "desc" ? matching.slice(-limit) : matching.slice(0, limit)

  return selected
}

function matches(entry: EventLogEntry<LeucoEvent>, query: LeucoEventQuery): boolean {
  if (entry.seq <= (query.sinceSeq ?? 0)) return false
  if (query.type !== undefined && entry.event.type !== query.type) return false
  if (query.project === undefined) return true
  if (!("project" in entry.event)) return false

  return entry.event.project === query.project
}
