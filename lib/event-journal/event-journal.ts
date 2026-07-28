import type { EventJournalRecord } from "@/event-journal/event-journal-record"
import type { EventJournalStore, EventJournalRelay } from "@/event-journal/event-journal-store"

type Listener<E> = (record: EventJournalRecord<E>) => void

type SinkErrorHandler<E> = (
  error: Error,
  record: EventJournalRecord<E>,
  sink: EventJournalRelay<E>,
) => void

export type EventJournalValidator<E> = (
  event: unknown,
) => { success: true; data: E } | { success: false; error: Error }

export type EventJournalProps<E> = {
  /** Validates each event before emission. Use `schema.safeParse` from any validation library, or a plain function. */
  validate: EventJournalValidator<E>
  /** Owns seq assignment + durability. Use `SqliteEventJournal` for multi-process safety. */
  primary: EventJournalStore<E>
  /** Optional fanout for already-sequenced records (memory ring, stdout, network mirror). */
  relays?: ReadonlyArray<EventJournalRelay<E>>
  /** Override for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Observer for relay failures. Default: silently swallow. */
  onSinkError?: SinkErrorHandler<E>
}

/**
 * Validated event journal. Three responsibilities and nothing else:
 * validate the event, delegate seq + persistence to the primary sink, and
 * fan the resulting record out to relays and live subscribers.
 *
 * Splitting "primary" from "relays" makes the seq invariant honest: there
 * is exactly one source of truth (the primary's atomic insert). Two
 * `EventJournal` instances pointed at the same SQLite file therefore see
 * one monotonic stream without journal-level coordination. Relays mirror
 * already-sequenced records, so they can be added or removed without
 * affecting correctness.
 *
 * Failure isolation:
 *   - Primary failure short-circuits append and is returned to the caller.
 *   - Relay failures never block the primary path — they surface via the
 *     optional `onSinkError` callback so the caller can observe without
 *     being interrupted.
 *   - A subscriber that throws is contained; the rest of the fanout
 *     completes normally.
 */
export class EventJournal<E> {
  private readonly validate: EventJournalValidator<E>
  private readonly primary: EventJournalStore<E>
  private readonly relays: ReadonlyArray<EventJournalRelay<E>>
  private readonly now: () => number
  private readonly onSinkError: SinkErrorHandler<E> | null
  private readonly listeners = new Set<Listener<E>>()

  constructor(props: EventJournalProps<E>) {
    this.validate = props.validate
    this.primary = props.primary
    this.relays = props.relays ?? []
    this.now = props.now ?? (() => Date.now())
    this.onSinkError = props.onSinkError ?? null
  }

  append(event: E): EventJournalRecord<E> | Error {
    const parsed = this.validate(event)
    if (!parsed.success) return parsed.error

    const result = this.callPrimary(parsed.data)
    if (result instanceof Error) return result

    this.fanOutToRelays(result)
    this.fanOutToListeners(result)

    return result
  }

  subscribe(listener: Listener<E>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getMaxSeq(): number {
    return this.primary.getMaxSeq()
  }

  close(): void {
    this.listeners.clear()
    this.callClose(this.primary)
    for (const relay of this.relays) this.callClose(relay)
  }

  private callPrimary(event: E): EventJournalRecord<E> | Error {
    try {
      return this.primary.insert({ ts: this.now(), event })
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }

  private fanOutToRelays(record: EventJournalRecord<E>): void {
    for (const relay of this.relays) {
      const error = this.callRelay(relay, record)
      if (!error) continue
      if (this.onSinkError) this.onSinkError(error, record, relay)
    }
  }

  private callRelay(relay: EventJournalRelay<E>, record: EventJournalRecord<E>): Error | null {
    try {
      const outcome = relay.write(record)
      return outcome instanceof Error ? outcome : null
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }

  private fanOutToListeners(record: EventJournalRecord<E>): void {
    for (const listener of this.listeners) {
      try {
        listener(record)
      } catch {
        // a faulty subscriber must not derail emission for everyone else
      }
    }
  }

  private callClose(sink: { close?(): void }): void {
    if (!sink.close) return
    try {
      sink.close()
    } catch {
      // close failures are best-effort by definition
    }
  }
}
