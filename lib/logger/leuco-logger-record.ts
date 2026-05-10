/**
 * Wrapper that `LeucoLogger.emit` puts around every event before handing it
 * to a sink. `seq` is monotonic across the lifetime of the underlying store —
 * sinks persist it as the primary key so replay (and broadcaster seeding
 * after restart) is an indexed range scan, not a full table walk. `ts` is
 * epoch milliseconds. `event` is the caller-defined payload validated by the
 * Zod schema passed to the bus.
 */
export type LeucoLoggerRecord<E> = {
  seq: number
  ts: number
  event: E
}
