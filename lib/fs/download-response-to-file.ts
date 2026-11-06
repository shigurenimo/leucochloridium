import { MAX_FILE_TRANSFER_BYTES } from "@/file-transfer-limits"
import { DownloadFileTransfer } from "@/fs/download-file-transfer"
import { assertTimerDelay } from "@/assert-timer-delay"

type Props = {
  fetchResponse: (signal: AbortSignal) => Promise<Response>
  outputPath: string
  maxBytes?: number
  timeoutMs?: number
  idleTimeoutMs?: number
  signal?: AbortSignal
}

export const downloadResponseToFile = async (
  props: Props,
): Promise<{ outputPath: string; size: number }> =>
  new DownloadFileTransfer({
    fetchResponse: props.fetchResponse,
    outputPath: props.outputPath,
    signal: props.signal,
    maxBytes: positiveInteger(props.maxBytes ?? MAX_FILE_TRANSFER_BYTES, "maxBytes"),
    timeoutMs: assertTimerDelay("download timeoutMs", props.timeoutMs ?? 60_000),
    idleTimeoutMs: assertTimerDelay("download idleTimeoutMs", props.idleTimeoutMs ?? 30_000),
  }).run()

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(
      `download ${name} must be an integer between 1 and ${Number.MAX_SAFE_INTEGER}, got ${value}`,
    )
  return value
}
