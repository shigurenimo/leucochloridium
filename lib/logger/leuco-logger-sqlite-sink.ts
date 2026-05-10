import { Database } from "bun:sqlite"
import type { SQLQueryBindings, Statement } from "bun:sqlite"
import type { LeucoLoggerRecord } from "@/logger/leuco-logger-record"
import type { LeucoLoggerPrimarySink, LeucoLoggerSink } from "@/logger/leuco-logger-sink"

type IndexValues<I extends ReadonlyArray<string>> = Record<I[number], string | null>

/**
 * Constructor props. The shape narrows on `I`: when no indexes are
 * declared (the default), `extractIndexes` is forbidden; when indexes
 * are declared, both `indexes` and `extractIndexes` are required and
 * `extractIndexes` is type-checked against the index keys.
 */
type Props<E, I extends ReadonlyArray<string>> = I extends readonly []
  ? {
      path: string
      maxRows?: number
      maxAgeMs?: number
      now?: () => number
      indexes?: I
      extractIndexes?: never
    }
  : {
      path: string
      maxRows?: number
      maxAgeMs?: number
      now?: () => number
      indexes: I
      extractIndexes: (event: E) => IndexValues<I>
    }

type GetRecordsProps<I extends ReadonlyArray<string>> = {
  /** Return only records with seq strictly greater than this. */
  sinceSeq?: number
  /** Filter by the top-level `event.type` discriminator. */
  type?: string
  /** Filter by indexed columns. Keys are constrained to the declared `indexes`. */
  where?: Partial<IndexValues<I>>
  /** Maximum rows returned. Default 1000. */
  limit?: number
}

type EventRow = {
  seq: number
  ts: number
  type: string | null
  event: string
}

type CountRow = { n: number }
type MaxRow = { max: number }
type VersionRow = { user_version: number }
type ColumnRow = { name: string }

/** Conservative whitelist for column names interpolated into SQL. */
const COLUMN_NAME_RE = /^[a-z_][a-z0-9_]*$/

const RESERVED_COLUMNS: ReadonlySet<string> = new Set(["seq", "ts", "type", "event"])

/**
 * Schema versions. Each entry is the list of DDL statements that take the
 * database from version i to version i + 1. Migrations run in a transaction
 * so a partial failure rolls back. Adding a new version is append-only —
 * never edit a published one. Caller-defined index columns are added
 * dynamically on construct (independent of versioned migrations) because
 * they are configuration, not schema evolution.
 */
const MIGRATIONS: ReadonlyArray<ReadonlyArray<string>> = [
  [
    "CREATE TABLE IF NOT EXISTS leuco_log (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT, event TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_leuco_log_ts ON leuco_log (ts)",
    "CREATE INDEX IF NOT EXISTS idx_leuco_log_type ON leuco_log (type)",
  ],
]

/**
 * SQLite-backed sink built on `bun:sqlite`. Implements both primary and
 * relay roles so the same instance can own seq generation for one bus and
 * mirror records from another (e.g. cross-process replication, restore
 * from a backup stream).
 *
 * Concurrency model: seq is `INTEGER PRIMARY KEY`, so SQLite assigns it
 * atomically via `lastInsertRowid`. Two `LeucoLogger` instances pointed
 * at the same database file therefore see one monotonically increasing
 * seq stream without any bus-level coordination — the database itself is
 * the synchronization point.
 *
 * Schema is version-managed via `PRAGMA user_version`. Migrations are
 * append-only and run in a transaction on every construct so a partial
 * upgrade rolls back cleanly. Caller-defined `indexes` are layered on top
 * via `ALTER TABLE ADD COLUMN` + `CREATE INDEX IF NOT EXISTS`, so adding
 * a new index to an existing database is a no-downtime operation.
 *
 * Type safety: the second generic parameter `I` is the literal tuple of
 * index column names. `extractIndexes` and `getRecords({ where })` are
 * both type-checked against this tuple, so a typo at the call site is a
 * compile-time error rather than a silent miss at runtime.
 *
 * Retention is bounded by `maxRows` and/or `maxAgeMs`. Both run on every
 * insert as a single indexed DELETE that no-ops below the cap.
 *
 * Bulk inserts use `insertMany`, which wraps the batch in one transaction
 * for ~10–100x throughput at the cost of one fsync per batch instead of
 * one per row.
 */
export class LeucoLoggerSqliteSink<E, const I extends ReadonlyArray<string> = readonly []>
  implements LeucoLoggerPrimarySink<E>, LeucoLoggerSink<E>
{
  private readonly db: Database
  private readonly maxRows: number | null
  private readonly maxAgeMs: number | null
  private readonly now: () => number
  private readonly indexes: I
  private readonly extractIndexes: ((event: E) => IndexValues<I>) | null
  private readonly insertStmt: Statement<unknown, SQLQueryBindings[]>
  private readonly insertWithSeqStmt: Statement<unknown, SQLQueryBindings[]>
  private readonly maxSeqStmt: Statement<MaxRow, []>
  private readonly countStmt: Statement<CountRow, []>
  private readonly trimRowsStmt: Statement<unknown, [number]>
  private readonly trimAgeStmt: Statement<unknown, [number]>

  constructor(props: Props<E, I>) {
    this.db = new Database(props.path)
    this.db.run("PRAGMA journal_mode = WAL")
    this.migrate()

    this.maxRows = props.maxRows ?? null
    this.maxAgeMs = props.maxAgeMs ?? null
    this.now = props.now ?? (() => Date.now())

    // The conditional `Props<E, I>` type widens to a union when `I` is a
    // generic, so TS can't narrow `props.indexes` back to `I` after the
    // runtime check. One cast at this boundary brings it back; everything
    // downstream stays I-typed.
    this.indexes = (props.indexes ?? []) as unknown as I

    if (this.indexes.length > 0) {
      validateIndexNames(this.indexes)
      this.extractIndexes = props.extractIndexes ?? null
      this.syncIndexColumns()
    } else {
      this.extractIndexes = null
    }

    const cols = ["ts", "type", "event", ...this.indexes]
    const placeholders = cols.map(() => "?").join(", ")
    this.insertStmt = this.db.prepare(
      `INSERT INTO leuco_log (${cols.join(", ")}) VALUES (${placeholders})`,
    )

    const colsWithSeq = ["seq", ...cols]
    const placeholdersWithSeq = colsWithSeq.map(() => "?").join(", ")
    this.insertWithSeqStmt = this.db.prepare(
      `INSERT INTO leuco_log (${colsWithSeq.join(", ")}) VALUES (${placeholdersWithSeq})`,
    )

    this.maxSeqStmt = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS max FROM leuco_log")
    this.countStmt = this.db.prepare("SELECT COUNT(*) AS n FROM leuco_log")
    this.trimRowsStmt = this.db.prepare(
      "DELETE FROM leuco_log WHERE seq <= (SELECT seq FROM leuco_log ORDER BY seq DESC LIMIT 1 OFFSET ?)",
    )
    this.trimAgeStmt = this.db.prepare("DELETE FROM leuco_log WHERE ts < ?")
  }

  insert(input: { ts: number; event: E }): LeucoLoggerRecord<E> | Error {
    try {
      const params = this.buildInsertParams(input.ts, input.event)
      const result = this.insertStmt.run(...params)
      const seq = Number(result.lastInsertRowid)
      this.trim()
      return { seq, ts: input.ts, event: input.event }
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }

  insertMany(inputs: ReadonlyArray<{ ts: number; event: E }>): LeucoLoggerRecord<E>[] | Error {
    if (inputs.length === 0) return []

    try {
      const records: LeucoLoggerRecord<E>[] = []
      const apply = this.db.transaction((batch: ReadonlyArray<{ ts: number; event: E }>) => {
        for (const input of batch) {
          const params = this.buildInsertParams(input.ts, input.event)
          const result = this.insertStmt.run(...params)
          records.push({
            seq: Number(result.lastInsertRowid),
            ts: input.ts,
            event: input.event,
          })
        }
      })
      apply(inputs)
      this.trim()
      return records
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }

  write(record: LeucoLoggerRecord<E>): void | Error {
    try {
      const params: SQLQueryBindings[] = [
        record.seq,
        ...this.buildInsertParams(record.ts, record.event),
      ]
      this.insertWithSeqStmt.run(...params)
      this.trim()
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }

  getMaxSeq(): number {
    const row = this.maxSeqStmt.get()
    return row ? row.max : 0
  }

  getRecords(props: GetRecordsProps<I> = {}): LeucoLoggerRecord<E>[] {
    const conditions: string[] = ["seq > ?"]
    const params: SQLQueryBindings[] = [props.sinceSeq ?? 0]

    if (typeof props.type === "string") {
      conditions.push("type = ?")
      params.push(props.type)
    }

    if (props.where) {
      this.appendWhereConditions(props.where, conditions, params)
    }

    const limit = props.limit ?? 1000
    params.push(limit)

    const sql = `SELECT seq, ts, type, event FROM leuco_log WHERE ${conditions.join(" AND ")} ORDER BY seq ASC LIMIT ?`
    const stmt = this.db.prepare<EventRow, SQLQueryBindings[]>(sql)
    return stmt.all(...params).map(toRecord<E>)
  }

  /**
   * Current schema version. Useful for diagnostics and for tests that want
   * to verify migrations ran. Reads `PRAGMA user_version` once per call.
   */
  getSchemaVersion(): number {
    const row = this.db.prepare<VersionRow, []>("PRAGMA user_version").get()
    return row?.user_version ?? 0
  }

  close(): void {
    this.db.close()
  }

  private buildInsertParams(ts: number, event: E): SQLQueryBindings[] {
    const type = extractType(event)
    const json = JSON.stringify(event)
    if (this.indexes.length === 0) return [ts, type, json]

    // The user's typed Record<I[number], V> is structurally a string-keyed
    // object at runtime; widen so we can index by `col: string` from the loop.
    const values = this.extractIndexes
      ? (this.extractIndexes(event) as unknown as Record<string, string | null>)
      : null
    const indexParams = this.indexes.map((col) => values?.[col] ?? null)
    return [ts, type, json, ...indexParams]
  }

  private appendWhereConditions(
    where: Partial<IndexValues<I>>,
    conditions: string[],
    params: SQLQueryBindings[],
  ): void {
    const widened = where as unknown as Partial<Record<string, string | null>>
    for (const col of this.indexes) {
      const value = widened[col]
      if (value === undefined) continue
      if (value === null) {
        conditions.push(`${col} IS NULL`)
      } else {
        conditions.push(`${col} = ?`)
        params.push(value)
      }
    }
  }

  private trim(): void {
    if (this.maxRows !== null) {
      const row = this.countStmt.get()
      if (row && row.n > this.maxRows) this.trimRowsStmt.run(this.maxRows)
    }

    if (this.maxAgeMs !== null) {
      this.trimAgeStmt.run(this.now() - this.maxAgeMs)
    }
  }

  private syncIndexColumns(): void {
    const existing = new Set(
      this.db
        .prepare<ColumnRow, []>("PRAGMA table_info(leuco_log)")
        .all()
        .map((r) => r.name),
    )

    for (const col of this.indexes) {
      if (!existing.has(col)) {
        this.db.run(`ALTER TABLE leuco_log ADD COLUMN ${col} TEXT`)
      }
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_leuco_log_${col} ON leuco_log (${col})`)
    }
  }

  private migrate(): void {
    const row = this.db.prepare<VersionRow, []>("PRAGMA user_version").get()
    const current = row?.user_version ?? 0
    if (current >= MIGRATIONS.length) return

    const pending = MIGRATIONS.slice(current)
    let version = current

    for (const stmts of pending) {
      version += 1
      const apply = this.db.transaction(() => {
        for (const stmt of stmts) this.db.run(stmt)
        this.db.run(`PRAGMA user_version = ${version}`)
      })
      apply()
    }
  }
}

function validateIndexNames(names: ReadonlyArray<string>): void {
  for (const name of names) {
    if (!COLUMN_NAME_RE.test(name)) {
      throw new Error(`invalid index column name: ${name}`)
    }
    if (RESERVED_COLUMNS.has(name)) {
      throw new Error(`reserved index column name: ${name}`)
    }
  }
}

function extractType(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null
  if (!("type" in event)) return null
  const t = event.type
  return typeof t === "string" ? t : null
}

function toRecord<E>(row: EventRow): LeucoLoggerRecord<E> {
  return {
    seq: row.seq,
    ts: row.ts,
    event: JSON.parse(row.event),
  }
}
