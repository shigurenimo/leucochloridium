import { DEFAULT_LOCAL_DATA_MAX_BYTES } from "@/fs/local-data-limits"
import { readRegularBytes } from "@/fs/read-regular-bytes"

export function readRegularText(
  path: string,
  maxBytes = DEFAULT_LOCAL_DATA_MAX_BYTES,
  options: { followSymlinks?: boolean } = {},
): string {
  return readRegularBytes(path, maxBytes, options).toString("utf8")
}
