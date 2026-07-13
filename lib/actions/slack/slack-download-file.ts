import { randomUUID } from "node:crypto"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { fetchSlackFile } from "@/actions/slack/fetch-slack-file"

type Props = {
  botToken: string
  url: string
  outputPath: string
  maxBytes?: number
  timeoutMs?: number
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

export const slackDownloadFile = async (
  props: Props,
): Promise<{ outputPath: string; size: number }> => {
  const maxBytes = props.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`download maxBytes must be a positive integer, got ${maxBytes}`)
  }
  const timeoutMs = props.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`download timeoutMs must be a positive integer, got ${timeoutMs}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await downloadWithLimits(props, maxBytes, timeoutMs, controller.signal)
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`slack file download timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

const downloadWithLimits = async (
  props: Props,
  maxBytes: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ outputPath: string; size: number }> => {
  const response = await fetchSlackFile(props.url, props.botToken, timeoutMs, signal)
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`download failed: ${response.status} ${response.statusText}`)
  }

  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`download exceeds ${maxBytes} byte limit (content-length ${contentLength})`)
  }

  await mkdir(dirname(props.outputPath), { recursive: true })
  const tempPath = `${props.outputPath}.${process.pid}.${randomUUID()}.tmp`
  let size = 0

  try {
    const file = await open(tempPath, "wx", 0o600)
    try {
      const reader = response.body?.getReader()
      if (reader !== undefined) {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          if (signal.aborted) throw new Error("download aborted")
          size += next.value.byteLength
          if (size > maxBytes) {
            await reader.cancel().catch(() => undefined)
            throw new Error(`download exceeds ${maxBytes} byte limit`)
          }

          let offset = 0
          while (offset < next.value.byteLength) {
            const written = await file.write(next.value, offset, next.value.byteLength - offset)
            if (written.bytesWritten === 0) throw new Error("download write made no progress")
            offset += written.bytesWritten
          }
        }
      }
    } finally {
      await file.close()
    }

    if (signal.aborted) throw new Error("download aborted")
    await rename(tempPath, props.outputPath)
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw err
  }

  return { outputPath: props.outputPath, size }
}
