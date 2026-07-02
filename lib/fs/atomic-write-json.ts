import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
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
 * protects against power loss, where the rename's metadata could otherwise
 * hit disk before the temp file's data blocks — leaving an empty or torn
 * settings.json (all projects + Slack tokens).
 *
 * Used wherever a partial write would lose data — settings.json (tokens),
 * agents/state.json (codex thread id), global settings.json. Same-directory
 * temp file is important because `rename` is only atomic within a single
 * filesystem.
 */
export const atomicWriteJson = (props: Props): string => {
  const dir = dirname(props.path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const tempPath = `${props.path}.${process.pid}.${Date.now()}.tmp`
  try {
    // Create with the restrictive mode so the temp file never exists with
    // world-readable bits before the chmod — settings.json holds Slack tokens.
    // The explicit chmodSync still runs to override umask, which can clear bits
    // off the open() mode.
    const fd = openSync(tempPath, "w", props.mode)
    try {
      writeSync(fd, `${JSON.stringify(props.data, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (props.mode !== undefined) chmodSync(tempPath, props.mode)
    renameSync(tempPath, props.path)
    return props.path
  } catch (error) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // best-effort cleanup
    }
    throw error
  }
}
