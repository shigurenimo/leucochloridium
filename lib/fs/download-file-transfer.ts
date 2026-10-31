import { randomUUID } from "node:crypto"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { errorMessage } from "@/error-message"
import { awaitDownloadStep } from "@/fs/await-download-step"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"

type ByteReader = {
  read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
  releaseLock(): void
}
type File = Awaited<ReturnType<typeof open>>
type DownloadTransferOptions = {
  fetchResponse: (signal: AbortSignal) => Promise<Response>
  outputPath: string
  maxBytes: number
  timeoutMs: number
  idleTimeoutMs: number
  signal?: AbortSignal
}

/** Owns the response, reader, file and private temporary path through transfer and bounded cleanup. */
export class DownloadFileTransfer {
  private readonly controller = new AbortController()
  private readonly temporaryPath: string
  private readonly resources: {
    response: Response | null
    reader: ByteReader | null
    file: File | null
    temporaryCreated: boolean
    bytes: number
    started: boolean
  } = {
    response: null,
    reader: null,
    file: null,
    temporaryCreated: false,
    bytes: 0,
    started: false,
  }

  constructor(private readonly props: DownloadTransferOptions) {
    this.temporaryPath = `${props.outputPath}.${process.pid}.${randomUUID()}.tmp`
    Object.freeze(this)
  }

  async run(): Promise<{ outputPath: string; size: number }> {
    if (this.resources.started)
      throw new Error(
        "A download transfer can only run once; inspect the destination before starting a new transfer",
      )
    this.resources.started = true
    const onAbort = (): void => this.controller.abort(this.props.signal?.reason)
    this.props.signal?.addEventListener("abort", onAbort, { once: true })
    if (this.props.signal?.aborted) onAbort()
    const timer = setTimeout(
      () =>
        this.controller.abort(
          new Error(`slack file download timed out after ${this.props.timeoutMs}ms`),
        ),
      this.props.timeoutMs,
    )
    try {
      return await this.transfer()
    } catch (error) {
      clearTimeout(timer)
      const primary = this.controller.signal.aborted ? this.controller.signal.reason : error
      this.controller.abort(primary)
      const failures: unknown[] = [primary]
      if (error !== primary) failures.push(error)
      failures.push(...(await this.cleanup(true, primary)))
      if (this.resources.temporaryCreated) {
        try {
          await awaitBoundedCleanup(
            rm(this.temporaryPath, { force: true }),
            `temporary-file removal (${this.temporaryPath})`,
          )
        } catch (cleanup) {
          failures.push(cleanup)
        }
      }
      return this.fail(failures)
    } finally {
      clearTimeout(timer)
      this.props.signal?.removeEventListener("abort", onAbort)
    }
  }

  private async transfer(): Promise<{ outputPath: string; size: number }> {
    this.controller.signal.throwIfAborted()
    const response = await awaitDownloadStep(
      this.props.fetchResponse(this.controller.signal),
      this.controller,
      this.props.idleTimeoutMs,
    )
    this.resources.response = response
    this.validateResponse(response)
    if (response.bodyUsed) throw new Error("download failed: response body was already consumed")
    const body = response.body
    if (body === null) throw new Error("download failed: response body is empty")
    this.controller.signal.throwIfAborted()
    await mkdir(dirname(this.props.outputPath), { recursive: true })
    this.controller.signal.throwIfAborted()
    const file = await open(this.temporaryPath, "wx", 0o600)
    this.resources.file = file
    this.resources.temporaryCreated = true
    const reader = body.getReader()
    this.resources.reader = reader
    await this.writeResponse(reader, file)
    const failures = await this.cleanup(false, null)
    if (failures.length) this.fail(failures)
    this.controller.signal.throwIfAborted()
    await rename(this.temporaryPath, this.props.outputPath)
    this.resources.temporaryCreated = false
    if (this.controller.signal.aborted)
      throw new Error(
        "Download destination was published as cancellation arrived; inspect the destination before retrying",
        { cause: this.controller.signal.reason },
      )
    return { outputPath: this.props.outputPath, size: this.resources.bytes }
  }

  private validateResponse(response: Response): void {
    if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`)
    const length = Number(response.headers.get("content-length"))
    if (Number.isFinite(length) && length > this.props.maxBytes)
      throw new Error(
        `download exceeds ${this.props.maxBytes} byte limit (content-length ${length})`,
      )
  }

  private async writeResponse(reader: ByteReader, file: File): Promise<void> {
    const progress = { idleDeadline: performance.now() + this.props.idleTimeoutMs }
    while (true) {
      const remaining = progress.idleDeadline - performance.now()
      if (remaining <= 0)
        this.controller.abort(
          new Error(`download timed out after ${this.props.idleTimeoutMs}ms without data`),
        )
      this.controller.signal.throwIfAborted()
      const next = await awaitDownloadStep(
        reader.read(),
        this.controller,
        Math.max(1, Math.ceil(remaining)),
      )
      if (next.done) return
      if (!(next.value instanceof Uint8Array))
        throw new Error("download failed: expected Uint8Array body chunks")
      this.controller.signal.throwIfAborted()
      if (next.value.byteLength === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        continue
      }
      this.resources.bytes += next.value.byteLength
      if (this.resources.bytes > this.props.maxBytes)
        throw new Error(`download exceeds ${this.props.maxBytes} byte limit`)
      await this.writeChunk(file, next.value)
      progress.idleDeadline = performance.now() + this.props.idleTimeoutMs
    }
  }

  private async writeChunk(file: File, chunk: Uint8Array): Promise<void> {
    const written = { offset: 0 }
    while (written.offset < chunk.byteLength) {
      this.controller.signal.throwIfAborted()
      const result = await file.write(chunk, written.offset, chunk.byteLength - written.offset)
      if (result.bytesWritten === 0) throw new Error("download write made no progress")
      written.offset += result.bytesWritten
    }
  }

  private async cleanup(cancel: boolean, reason: unknown): Promise<unknown[]> {
    const failures: unknown[] = []
    const reader = this.resources.reader
    if (cancel) {
      try {
        if (reader !== null) await awaitBoundedCleanup(reader.cancel(reason), "reader cancellation")
        else if (this.resources.response?.body)
          await awaitBoundedCleanup(
            this.resources.response.body.cancel(reason),
            "body cancellation",
          )
      } catch (error) {
        failures.push(error)
      }
    }
    if (reader !== null) {
      try {
        reader.releaseLock()
        this.resources.reader = null
      } catch (error) {
        failures.push(error)
      }
    }
    const file = this.resources.file
    this.resources.file = null
    if (file !== null) {
      try {
        await awaitBoundedCleanup(file.close(), `file close (${this.temporaryPath})`)
      } catch (error) {
        failures.push(error)
      }
    }
    return failures
  }

  private fail(errors: unknown[]): never {
    const failures = [...new Set(errors)]
    if (failures.length === 1) throw failures[0]
    throw new AggregateError(
      failures,
      `Download failed: ${errorMessage(failures[0])}; ${failures.length - 1} additional failure(s)`,
      { cause: failures[0] },
    )
  }
}
