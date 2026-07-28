import { Database } from "bun:sqlite"

type Props = {
  path: string
  maxRows: number
  maxAgeMs: number
  maxBytes: number
  targetBytes: number
  now: () => number
}

type NameRow = {
  name: string
}

type PageCountRow = {
  page_count: number
}

type PageSizeRow = {
  page_size: number
}

type CountRow = {
  count: number
}

export function maintainLeucoEventJournal(props: Props): void {
  if (props.path === ":memory:") return

  const database = new Database(props.path)

  try {
    const table = database
      .prepare<NameRow, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'logs'")
      .get()

    if (table === null) return

    trimRows(database, props.maxRows)
    database
      .prepare<unknown, [number]>("DELETE FROM logs WHERE ts < ?")
      .run(props.now() - props.maxAgeMs)
    trimBytes(database, props)
  } finally {
    database.close()
  }
}

function trimRows(database: Database, maxRows: number): void {
  database
    .prepare<unknown, [number]>(
      "DELETE FROM logs WHERE seq <= (SELECT seq FROM logs ORDER BY seq DESC LIMIT 1 OFFSET ?)",
    )
    .run(maxRows)
}

function trimBytes(database: Database, props: Props): void {
  const pageCount = database.prepare<PageCountRow, []>("PRAGMA page_count").get()?.page_count ?? 0
  const pageSize = database.prepare<PageSizeRow, []>("PRAGMA page_size").get()?.page_size ?? 0
  const bytes = pageCount * pageSize

  if (bytes <= props.maxBytes) return

  const rows =
    database.prepare<CountRow, []>("SELECT COUNT(*) AS count FROM logs").get()?.count ?? 0
  if (rows === 0) return

  const bytesPerRow = Math.max(1, bytes / rows)
  const rowsToDrop = Math.min(rows, Math.ceil((bytes - props.targetBytes) / bytesPerRow))

  database
    .prepare<unknown, [number]>(
      "DELETE FROM logs WHERE seq IN (SELECT seq FROM logs ORDER BY seq ASC LIMIT ?)",
    )
    .run(rowsToDrop)
  database.run("PRAGMA wal_checkpoint(TRUNCATE)")
  database.run("VACUUM")
}
