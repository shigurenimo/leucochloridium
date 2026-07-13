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
  path: string
  text: string
  mode: number
}

/** Write sensitive text through a same-directory temporary file. */
export const atomicWriteText = (props: Props): string => {
  const dir = dirname(props.path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const tempPath = `${props.path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    const fd = openSync(tempPath, "wx", props.mode)
    try {
      writeSync(fd, props.text)
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
