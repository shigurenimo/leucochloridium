import { openSync, fstatSync, readFileSync, closeSync, constants } from "node:fs"

export function readRegularText(path: string, maxBytes = 16 * 1024 * 1024): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const file = fstatSync(descriptor)
    if (!file.isFile())
      throw new Error("Expected a regular file; pipes/devices are never read as CLI data")
    if (file.size > maxBytes) throw new Error(`Local data exceeds the ${maxBytes} byte read limit`)
    return readFileSync(descriptor, "utf8")
  } finally {
    closeSync(descriptor)
  }
}
