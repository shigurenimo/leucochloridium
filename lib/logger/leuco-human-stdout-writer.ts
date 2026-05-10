import type { LeucoHumanRecord } from "@/logger/leuco-human-record"
import type { LeucoHumanWriter } from "@/logger/leuco-human-writer"

type Stream = { write(s: string): void }

type Props = {
  /** Override for tests. Defaults to `process.stdout`. */
  out?: Stream
}

/**
 * Writes one JSON line per record to stdout. Useful as the default writer
 * for foreground daemons, dev runs, and short-lived processes where a
 * file-backed log would be overkill.
 */
export class LeucoHumanStdoutWriter implements LeucoHumanWriter {
  private readonly out: Stream

  constructor(props: Props = {}) {
    this.out = props.out ?? process.stdout
  }

  write(record: LeucoHumanRecord): void {
    this.out.write(`${JSON.stringify(record)}\n`)
  }
}
