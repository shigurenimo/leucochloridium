import type { EventJournalRecord } from "@/event-journal/event-journal-record"
import type { LeucoEventQuery } from "@/events/leuco-event-query"
import type { LeucoEvent } from "@/events/leuco-event-types"

export function queryLeucoEventRecords(
  records: ReadonlyArray<EventJournalRecord<LeucoEvent>>,
  query: LeucoEventQuery,
): ReadonlyArray<EventJournalRecord<LeucoEvent>> {
  const matching = records.filter((record) => matches(record, query))
  const limit = query.limit ?? 1000
  const selected = query.order === "desc" ? matching.slice(-limit) : matching.slice(0, limit)

  return selected
}

function matches(record: EventJournalRecord<LeucoEvent>, query: LeucoEventQuery): boolean {
  if (record.seq <= (query.sinceSeq ?? 0)) return false
  if (query.type !== undefined && record.event.type !== query.type) return false
  if (query.project === undefined) return true
  if (!("project" in record.event)) return false

  return record.event.project === query.project
}
