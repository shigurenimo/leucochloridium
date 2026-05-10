import type { LeucoHumanRecord } from "@/logger/leuco-human-record"

/**
 * Plugin port for `LeucoHumanLogger`. Writers decide where diagnostic
 * records land — stdout, JSONL file, syslog, network, etc. — without the
 * logger having to know about persistence shape.
 *
 * `write` returns `void` on success or an `Error` the logger surfaces via
 * `onWriteError`. Throwing is also tolerated; the logger catches.
 */
export type LeucoHumanWriter = {
  write(record: LeucoHumanRecord): void | Error
  close?(): void
}
