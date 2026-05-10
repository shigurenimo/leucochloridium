import type { ZodType } from "zod"
import type { LeucoLoggerRecord } from "@/logger/leuco-logger-record"
import type { LeucoLoggerPrimarySink, LeucoLoggerSink } from "@/logger/leuco-logger-sink"

type Listener<E> = (record: LeucoLoggerRecord<E>) => void

type SinkErrorHandler<E> = (
  error: Error,
  record: LeucoLoggerRecord<E>,
  sink: LeucoLoggerSink<E>,
) => void

type Props<E> = {
  /** Zod schema for the event union. Validated on every `emit`. */
  schema: ZodType<E>
  /** Owns seq assignment + durability. Use `LeucoLoggerSqliteSink` for multi-process safety. */
  primary: LeucoLoggerPrimarySink<E>
  /** Optional fanout for already-sequenced records (memory ring, stdout, network mirror). */
  relays?: ReadonlyArray<LeucoLoggerSink<E>>
  /** Override for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Observer for relay failures. Default: silently swallow. */
  onSinkError?: SinkErrorHandler<E>
}

/**
 * Schema-validated event log bus. Three responsibilities and nothing else:
 * validate the event, delegate seq + persistence to the primary sink, and
 * fan the resulting record out to relays and live subscribers.
 *
 * Splitting "primary" from "relays" makes the seq invariant honest: there
 * is exactly one source of truth (the primary's atomic insert). Two
 * `LeucoLogger` instances pointed at the same SQLite file therefore see
 * one monotonic stream without bus-level coordination. Relays mirror
 * already-sequenced records, so they can be added or removed without
 * affecting correctness.
 *
 * Failure isolation:
 *   - Primary failure short-circuits emit and is returned to the caller.
 *   - Relay failures never block the primary path — they surface via the
 *     optional `onSinkError` callback so the caller can observe without
 *     being interrupted.
 *   - A subscriber that throws is contained; the rest of the fanout
 *     completes normally.
 */
export class LeucoLogger<E> {
  private readonly schema: ZodType<E>
  private readonly primary: LeucoLoggerPrimarySink<E>
  private readonly relays: ReadonlyArray<LeucoLoggerSink<E>>
  private readonly now: () => number
  private readonly onSinkError: SinkErrorHandler<E> | null
  private readonly listeners = new Set<Listener<E>>()

  constructor(props: Props<E>) {
    this.schema = props.schema
    this.primary = props.primary
    this.relays = props.relays ?? []
    this.now = props.now ?? (() => Date.now())
    this.onSinkError = props.onSinkError ?? null
  }

  emit(event: E): LeucoLoggerRecord<E> | Error {
    const parsed = this.schema.safeParse(event)
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

  private callPrimary(event: E): LeucoLoggerRecord<E> | Error {
    try {
      return this.primary.insert({ ts: this.now(), event })
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }

  private fanOutToRelays(record: LeucoLoggerRecord<E>): void {
    for (const relay of this.relays) {
      const error = this.callRelay(relay, record)
      if (!error) continue
      if (this.onSinkError) this.onSinkError(error, record, relay)
    }
  }

  private callRelay(relay: LeucoLoggerSink<E>, record: LeucoLoggerRecord<E>): Error | null {
    try {
      const outcome = relay.write(record)
      return outcome instanceof Error ? outcome : null
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }

  private fanOutToListeners(record: LeucoLoggerRecord<E>): void {
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
