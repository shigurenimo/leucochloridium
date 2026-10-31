import { DEFAULT_LOCAL_DATA_MAX_BYTES } from "@/fs/local-data-limits"
import { openSync, fstatSync, closeSync, constants, lstatSync } from "node:fs"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"
import { readBoundedBytesDescriptor } from "@/fs/read-bounded-bytes-descriptor"

export function readRegularBytes(
  path: string,
  maxBytes = DEFAULT_LOCAL_DATA_MAX_BYTES,
  options: { followSymlinks?: boolean } = {},
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER)
    throw new Error(
      "Text read limit must be a non-negative safe integer below Number.MAX_SAFE_INTEGER",
    )
  if (options.followSymlinks === false && lstatSync(path).isSymbolicLink())
    throw new Error("Refusing to read a symbolic link as local data")
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      constants.O_NONBLOCK |
      (options.followSymlinks === false ? (constants.O_NOFOLLOW ?? 0) : 0),
  )
  return withSyncCleanup(
    () => {
      const file = fstatSync(descriptor)
      if (!file.isFile())
        throw new Error("Expected a regular file; pipes/devices are never read as CLI data")
      if (file.size > maxBytes)
        throw new Error(`Local data exceeds the ${maxBytes} byte read limit`)
      return readBoundedBytesDescriptor(descriptor, maxBytes)
    },
    () => closeSync(descriptor),
  )
}
