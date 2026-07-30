import { randomUUID } from "node:crypto"
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
  path: string
  text: string
  mode: number
}

/**
 * Atomically replace a sensitive text file through a same-directory temporary
 * file. The restrictive mode is applied at creation time, before any secret
 * bytes are written. `writeFileSync` completes the full write, fsync flushes
 * the temporary file contents, and rename prevents readers from observing a
 * partially-written destination. Directory-entry durability across sudden
 * power loss remains filesystem-dependent.
 */
export const atomicWriteText = (props: Props): string => {
  const dir = dirname(props.path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const tempPath = `${props.path}.${process.pid}.${randomUUID()}.tmp`
  try {
    const fd = openSync(tempPath, "wx", props.mode)
    try {
      writeFileSync(fd, props.text, { encoding: "utf8" })
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(tempPath, props.mode)
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
