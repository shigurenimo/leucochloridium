import { MAX_FILE_TRANSFER_BYTES } from "@/file-transfer-limits"
import { DownloadFileTransfer } from "@/fs/download-file-transfer"
import { MAX_TIMER_DELAY_MS } from "@/timer-limits"

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
    timeoutMs: positiveInteger(props.timeoutMs ?? 60_000, "timeoutMs", MAX_TIMER_DELAY_MS),
    idleTimeoutMs: positiveInteger(
      props.idleTimeoutMs ?? 30_000,
      "idleTimeoutMs",
      MAX_TIMER_DELAY_MS,
    ),
  }).run()

const positiveInteger = (
  value: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`download ${name} must be an integer between 1 and ${maximum}, got ${value}`)
  return value
}
