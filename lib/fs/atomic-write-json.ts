import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
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
 * directory, optionally chmod it, then `renameSync` over the destination so
 * a crash mid-write leaves the existing file intact rather than truncated.
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
    // off the `writeFileSync` mode.
    writeFileSync(tempPath, `${JSON.stringify(props.data, null, 2)}\n`, {
      mode: props.mode,
    })
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
