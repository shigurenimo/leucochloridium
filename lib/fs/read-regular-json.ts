import { DEFAULT_LOCAL_DATA_MAX_BYTES } from "@/fs/local-data-limits"
import { readRegularBytes } from "@/fs/read-regular-bytes"

export function readRegularJson(path: string): unknown {
  const bytes = readRegularBytes(path, DEFAULT_LOCAL_DATA_MAX_BYTES)
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch (cause) {
    throw new Error(`Local JSON file is not valid UTF-8 JSON: ${path}`, { cause })
  }
}
