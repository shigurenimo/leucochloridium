import { randomUUID } from "node:crypto"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { fetchSlackFile } from "@/actions/slack/fetch-slack-file"

type Props = {
  botToken: string
  url: string
  outputPath: string
  maxBytes?: number
  /** Hard deadline for the complete download. */
  timeoutMs?: number
  /** Maximum wait for the response or each successive body chunk. */
  idleTimeoutMs?: number
}

type ByteReader = {
  read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
  releaseLock(): void
}

type DownloadState = {
  byteLength: number
  temporaryCreated: boolean
  reader?: ByteReader
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_IDLE_TIMEOUT_MS = 30_000

export const slackDownloadFile = async (
  props: Props,
): Promise<{ outputPath: string; size: number }> => {
  const maxBytes = positiveInteger(props.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes")
  const timeoutMs = positiveInteger(props.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs")
  const idleTimeoutMs = positiveInteger(
    props.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    "idleTimeoutMs",
  )
  const controller = new AbortController()
  const hardTimeout: { error?: Error } = {}
  const timer = setTimeout(() => {
    const error = new Error(`slack file download timed out after ${timeoutMs}ms`)
    hardTimeout.error = error
    controller.abort(error)
  }, timeoutMs)

  try {
    return await downloadWithLimits({
      props,
      maxBytes,
      timeoutMs,
      idleTimeoutMs,
      controller,
    })
  } catch (error) {
    if (hardTimeout.error !== undefined) throw hardTimeout.error
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const downloadWithLimits = async (request: {
  props: Props
  maxBytes: number
  timeoutMs: number
  idleTimeoutMs: number
  controller: AbortController
}): Promise<{ outputPath: string; size: number }> => {
  const response = await withIdleTimeout(
    fetchSlackFile(
      request.props.url,
      request.props.botToken,
      request.timeoutMs,
      request.controller.signal,
    ),
    request.idleTimeoutMs,
    (error) => request.controller.abort(error),
  )

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`download failed: ${response.status} ${response.statusText}`)
  }

  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > request.maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(
      `download exceeds ${request.maxBytes} byte limit (content-length ${contentLength})`,
    )
  }

  await mkdir(dirname(request.props.outputPath), { recursive: true })
  const temporaryPath = `${request.props.outputPath}.${process.pid}.${randomUUID()}.tmp`
  const state: DownloadState = { byteLength: 0, temporaryCreated: false }

  try {
    const temporaryFile = await open(temporaryPath, "wx", 0o600)
    state.temporaryCreated = true
    try {
      const body = response.body
      if (body === null) throw new Error("download failed: response body is empty")
      const reader: ByteReader = body.getReader()
      state.reader = reader
      try {
        await writeResponse({
          reader,
          file: temporaryFile,
          state,
          maxBytes: request.maxBytes,
          idleTimeoutMs: request.idleTimeoutMs,
          controller: request.controller,
        })
      } finally {
        releaseReader(reader)
      }
    } finally {
      await temporaryFile.close()
    }

    if (request.controller.signal.aborted) throw request.controller.signal.reason
    await rename(temporaryPath, request.props.outputPath)
    state.temporaryCreated = false
  } catch (error) {
    if (!request.controller.signal.aborted) request.controller.abort(error)
    if (state.reader !== undefined) await cancelReader(state.reader, error)
    if (state.temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }

  return { outputPath: request.props.outputPath, size: state.byteLength }
}

const writeResponse = async (request: {
  reader: ByteReader
  file: Awaited<ReturnType<typeof open>>
  state: DownloadState
  maxBytes: number
  idleTimeoutMs: number
  controller: AbortController
}): Promise<void> => {
  while (true) {
    const next = await withIdleTimeout(request.reader.read(), request.idleTimeoutMs, (error) => {
      request.controller.abort(error)
      void cancelReader(request.reader, error)
    })
    if (next.done) return
    if (request.controller.signal.aborted) throw request.controller.signal.reason

    request.state.byteLength += next.value.byteLength
    if (request.state.byteLength > request.maxBytes) {
      await cancelReader(request.reader, new Error("download size limit exceeded"))
      throw new Error(`download exceeds ${request.maxBytes} byte limit`)
    }

    const writeState = { offset: 0 }
    while (writeState.offset < next.value.byteLength) {
      const written = await request.file.write(
        next.value,
        writeState.offset,
        next.value.byteLength - writeState.offset,
      )
      if (written.bytesWritten === 0) throw new Error("download write made no progress")
      writeState.offset += written.bytesWritten
    }
  }
}

const withIdleTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: (error: Error) => void,
): Promise<T> => {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => {
    const error = new Error(`download timed out after ${timeoutMs}ms without data`)
    timeout.reject(error)
    onTimeout(error)
  }, timeoutMs)

  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

const cancelReader = async (reader: ByteReader, reason: unknown): Promise<void> => {
  try {
    await reader.cancel(reason)
  } catch {
    // The body may already be errored or the reader lock released.
  }
}

const releaseReader = (reader: ByteReader): void => {
  try {
    reader.releaseLock()
  } catch {
    // A timeout cancellation can still have a pending read at this instant.
  }
}

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`download ${name} must be a positive integer, got ${value}`)
  }
  return value
}
