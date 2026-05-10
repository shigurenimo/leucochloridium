import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"
import type { LeucoHumanRecord } from "@/logger/leuco-human-record"
import type { LeucoHumanWriter } from "@/logger/leuco-human-writer"

type Props = {
  /** Filesystem path. Parent directory is created on construct. */
  path: string
  /**
   * Optional size cap in bytes. When the next write would push the file
   * over the cap, the existing file becomes `<path>.1` (replacing any
   * prior `.1`) and a fresh file takes its place. Single-keep rotation —
   * a second cycle drops the previous `.1`.
   */
  maxBytes?: number
}

/**
 * Appends one JSON line per record to a file. Optional one-keep size
 * rotation. Designed for diagnostic logs a human tails (`tail -f file |
 * jq`); not for replay or queries — use `LeucoLoggerSqliteSink` if you
 * need indexed lookups.
 *
 * Writes are synchronous (`appendFileSync`), so each line is durable
 * before `write` returns. Throughput matches the OS file cache; for
 * high-volume logging consider buffering at the call site or using a
 * different writer.
 */
export class LeucoHumanFileWriter implements LeucoHumanWriter {
  private readonly path: string
  private readonly maxBytes: number | null

  constructor(props: Props) {
    this.path = props.path
    this.maxBytes = props.maxBytes ?? null
    this.ensureDir()
  }

  write(record: LeucoHumanRecord): void | Error {
    try {
      const line = `${JSON.stringify(record)}\n`
      this.rotateIfNeeded(Buffer.byteLength(line))
      appendFileSync(this.path, line)
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }

  private ensureDir(): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (this.maxBytes === null) return
    if (!existsSync(this.path)) return

    const size = statSync(this.path).size
    if (size + incomingBytes <= this.maxBytes) return

    const backup = `${this.path}.1`
    if (existsSync(backup)) unlinkSync(backup)
    renameSync(this.path, backup)
  }
}
