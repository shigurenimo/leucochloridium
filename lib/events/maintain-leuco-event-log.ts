import { withSyncCleanup } from "@/fs/with-sync-cleanup"
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

type FreelistCountRow = {
  freelist_count: number
}

type CountRow = {
  count: number
}

export function maintainLeucoEventLog(props: Props): void {
  if (props.path === ":memory:") return

  const database = new Database(props.path)

  withSyncCleanup(
    () => {
      database.run("PRAGMA busy_timeout = 250")
      const table = database
        .prepare<NameRow, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'logs'",
        )
        .get()

      if (table === null) return

      trimRows(database, props.maxRows)
      database
        .prepare<unknown, [number]>("DELETE FROM logs WHERE ts < ?")
        .run(props.now() - props.maxAgeMs)
      trimBytes(database, props)
    },
    () => database.close(true),
  )
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

  if (pageCount * pageSize <= props.maxBytes) return

  // Pages freed by the row and age deletes stay in the file until VACUUM, so they must not count as row bytes.
  const freePages =
    database.prepare<FreelistCountRow, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0
  const usedBytes = Math.max(0, pageCount - freePages) * pageSize
  const rows =
    database.prepare<CountRow, []>("SELECT COUNT(*) AS count FROM logs").get()?.count ?? 0

  if (rows > 0 && usedBytes > props.targetBytes) {
    const bytesPerRow = Math.max(1, usedBytes / rows)
    const rowsToDrop = Math.min(rows, Math.ceil((usedBytes - props.targetBytes) / bytesPerRow))

    database
      .prepare<unknown, [number]>(
        "DELETE FROM logs WHERE seq IN (SELECT seq FROM logs ORDER BY seq ASC LIMIT ?)",
      )
      .run(rowsToDrop)
  }
  database.run("PRAGMA wal_checkpoint(TRUNCATE)")
  database.run("VACUUM")
}
