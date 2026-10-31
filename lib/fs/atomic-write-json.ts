import { encodeLocalJson } from "@/fs/encode-local-json"
import { randomUUID } from "node:crypto"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"

type Props = {
  /** Destination path. Parent directories are created as needed. */
  path: string
  /** Value to serialise via `JSON.stringify(data, null, 2)`. */
  data: unknown
  /** Optional file mode applied before the rename (e.g. `0o600` for secrets). */
  mode?: number
}

/**
 * Write a JSON file atomically: serialise into a temp file in the same
 * directory, fsync it, optionally chmod it, then `renameSync` over the
 * destination. The rename protects against a crash mid-write; the fsync
 * flushes the temporary file contents. Directory-entry durability across
 * sudden power loss remains filesystem-dependent.
 *
 * Used wherever a partial write would lose data, including settings.json
 * (configuration and credential references) and state.json. Same-directory
 * temp files are important because `rename` is only atomic within a filesystem.
 */
export const atomicWriteJson = (props: Props): string => {
  const encoded = encodeLocalJson(props.data)
  const dir = dirname(props.path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const tempPath = `${props.path}.${process.pid}.${randomUUID()}.tmp`
  const temporary = { created: false }
  return withSyncCleanup(
    () => {
      const fd = openSync(tempPath, "wx", props.mode)
      temporary.created = true
      withSyncCleanup(
        () => {
          writeFileSync(fd, encoded, { encoding: "utf8" })
          fsyncSync(fd)
        },
        () => closeSync(fd),
      )
      if (props.mode !== undefined) chmodSync(tempPath, props.mode)
      renameSync(tempPath, props.path)
      temporary.created = false
      return props.path
    },
    () => {
      if (temporary.created) rmSync(tempPath, { force: true })
    },
  )
}
