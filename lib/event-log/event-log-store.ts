import type { EventLogEntry } from "@/event-log/event-log-entry"

/**
 * Relay sink. Receives records that already have a `seq` assigned by the
 * primary and stores or forwards them — memory ring, stdout, network push,
 * a second SQLite mirror, etc. Does not generate seq itself, so any number
 * can be attached and they all observe the same monotonic stream.
 *
 * `write` returns `void` on success or an `Error` the `EventLog` surfaces via
 * `onSinkError`. Throwing is also tolerated (`EventLog` catches it), but
 * returning is preferred so the failure path is part of the type.
 */
export type EventLogRelay<E> = {
  write(record: EventLogEntry<E>): void | Error
  close?(): void
}

/**
 * Primary sink. Owns the canonical seq sequence for the log. `insert` is
 * the atomic boundary — it assigns a seq strictly greater than every
 * previously assigned one, persists the record, and returns it. SQLite
 * implementations get atomicity for free by delegating to `INTEGER PRIMARY
 * KEY` so two processes sharing one database file see one monotonic
 * stream without coordinating through `EventLog`.
 *
 * `getMaxSeq` is the highest seq currently in the sink — used for
 * observability and for replay seeding by clients reading the store.
 */
export type EventLogStore<E> = {
  insert(input: { ts: number; event: E }): EventLogEntry<E> | Error
  getMaxSeq(): number
  close?(): void
}
