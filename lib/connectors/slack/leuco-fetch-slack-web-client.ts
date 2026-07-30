import { Buffer } from "node:buffer"
import { z } from "zod"
import {
  LeucoSlackWebClient,
  type SlackAuthTest,
  type SlackConversationInfo,
  type SlackConversationList,
  type SlackFileUpload,
  type SlackHistoryMessage,
  type SlackHistorySlice,
  type SlackSearchMessages,
} from "@/connectors/slack/leuco-slack-web-client"
import { slackRateLimitDelayMs } from "@/connectors/slack/slack-rate-limit-delay"

export type LeucoFetchSlackWebClientProps = {
  botToken: string
  requestTimeoutMs?: number
  fetchFn?: SlackFetchPort
}

export type SlackFetchPort = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

const SLACK_API_BASE = "https://slack.com/api"
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/**
 * Raw-fetch implementation of `LeucoSlackWebClient`. Calls
 * `POST https://slack.com/api/<method>` with a bearer token, parses the
 * common `{ ok, error?, ... }` envelope, and normalizes the result into the
 * port's flat shapes. No `@slack/web-api` dependency.
 */
export class LeucoFetchSlackWebClient extends LeucoSlackWebClient {
  constructor(private readonly props: LeucoFetchSlackWebClientProps) {
    super()
    Object.freeze(this)
  }

  async chatPostMessage(args: {
    channel: string
    threadTs: string | null
    text: string
  }): Promise<void> {
    const body: Record<string, unknown> = { channel: args.channel, text: args.text }
    if (args.threadTs !== null) body.thread_ts = args.threadTs

    await this.callOk("chat.postMessage", body)
  }

  async reactionsAdd(args: { channel: string; timestamp: string; name: string }): Promise<void> {
    await this.callOk("reactions.add", {
      channel: args.channel,
      timestamp: args.timestamp,
      name: args.name,
    })
  }

  async reactionsRemove(args: { channel: string; timestamp: string; name: string }): Promise<void> {
    await this.callOk("reactions.remove", {
      channel: args.channel,
      timestamp: args.timestamp,
      name: args.name,
    })
  }

  async conversationsInfo(args: { channel: string }): Promise<SlackConversationInfo> {
    const raw = await this.callOk("conversations.info", { channel: args.channel })
    const parsed = conversationsInfoSchema.safeParse(raw)
    if (!parsed.success) return { isMember: null }
    return { isMember: parsed.data.channel.is_member ?? null }
  }

  async conversationsReplies(args: {
    channel: string
    ts: string
    oldest: string | null
    inclusive: boolean | null
    limit: number | null
  }): Promise<SlackHistorySlice> {
    const body: Record<string, unknown> = { channel: args.channel, ts: args.ts }
    if (args.oldest !== null) body.oldest = args.oldest
    if (args.inclusive !== null) body.inclusive = args.inclusive
    if (args.limit !== null) body.limit = args.limit

    return await this.history("conversations.replies", body)
  }

  async conversationsList(args: {
    types: string
    limit: number | null
    cursor?: string | null
  }): Promise<SlackConversationList> {
    const body: Record<string, unknown> = { types: args.types }
    if (args.limit !== null) body.limit = args.limit
    if (args.cursor) body.cursor = args.cursor

    const raw = await this.callOk("conversations.list", body)
    const parsed = conversationsListSchema.safeParse(raw)
    if (!parsed.success) return { channels: [] }

    const channels = parsed.data.channels.flatMap((channel) => {
      if (channel.id === undefined) return []
      return [{ id: channel.id, isIm: channel.is_im === true }]
    })
    return {
      channels,
      nextCursor: parsed.data.response_metadata?.next_cursor?.trim() || null,
    }
  }

  async conversationsHistory(args: {
    channel: string
    oldest: string | null
    inclusive: boolean | null
    limit: number | null
  }): Promise<SlackHistorySlice> {
    const body: Record<string, unknown> = { channel: args.channel }
    if (args.oldest !== null) body.oldest = args.oldest
    if (args.inclusive !== null) body.inclusive = args.inclusive
    if (args.limit !== null) body.limit = args.limit

    return await this.history("conversations.history", body)
  }

  async searchMessages(args: {
    query: string
    sort: "timestamp" | "score" | null
    sortDir: "asc" | "desc" | null
    count: number | null
  }): Promise<SlackSearchMessages> {
    const body: Record<string, unknown> = { query: args.query }
    if (args.sort !== null) body.sort = args.sort
    if (args.sortDir !== null) body.sort_dir = args.sortDir
    if (args.count !== null) body.count = args.count

    const raw = await this.callOk("search.messages", body)
    const parsed = searchMessagesSchema.safeParse(raw)
    if (!parsed.success) return { matches: [] }

    const matches = (parsed.data.messages?.matches ?? []).flatMap((match) => {
      if (match.channel?.id === undefined) return []
      if (match.ts === undefined) return []
      return [
        {
          channelId: match.channel.id,
          user: match.user ?? null,
          text: match.text ?? null,
          ts: match.ts,
          permalink: match.permalink ?? null,
        },
      ]
    })
    return { matches }
  }

  async authTest(): Promise<SlackAuthTest> {
    const raw = await this.callOk("auth.test", {})
    const parsed = authTestSchema.safeParse(raw)
    if (!parsed.success) return { userId: null }
    return { userId: parsed.data.user_id ?? null }
  }

  async filesUpload(args: SlackFileUpload): Promise<{ fileId: string }> {
    const prepared = await this.callOk("files.getUploadURLExternal", {
      filename: args.filename,
      length: args.content.byteLength,
    })
    const upload = slackExternalUploadSchema.safeParse(prepared)
    if (!upload.success) throw new Error("slack file upload: invalid prepare response")

    await this.postExternalFile(upload.data.upload_url, args)

    const body: Record<string, unknown> = {
      files: [{ id: upload.data.file_id, title: args.title }],
      channel_id: args.channelId,
    }
    if (args.threadTs !== null) body.thread_ts = args.threadTs
    if (args.initialComment !== null) body.initial_comment = args.initialComment
    await this.callOk("files.completeUploadExternal", body)

    return { fileId: upload.data.file_id }
  }

  async apiCall(method: string, body: Record<string, unknown>): Promise<unknown> {
    return FORM_ENCODED_METHODS.has(method)
      ? await this.postForm(method, body)
      : await this.post(method, body)
  }

  private async history(method: string, body: Record<string, unknown>): Promise<SlackHistorySlice> {
    const raw = await this.callOk(method, body)
    const parsed = historySchema.safeParse(raw)
    if (!parsed.success) return { messages: [] }

    const messages: SlackHistoryMessage[] = parsed.data.messages.flatMap((message) => {
      if (message.ts === undefined) return []
      return [
        {
          user: message.user ?? null,
          text: message.text ?? null,
          ts: message.ts,
          threadTs: message.thread_ts ?? null,
          replyCount: message.reply_count ?? null,
          subtype: message.subtype ?? null,
          botId: message.bot_id ?? null,
        },
      ]
    })
    return { messages }
  }

  private async callOk(method: string, body: Record<string, unknown>): Promise<unknown> {
    const raw = await this.apiCall(method, body)
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`slack ${method}: response is not an object`)
    }
    const okField = (raw as { ok?: unknown }).ok
    if (okField !== true) {
      const errField = (raw as { error?: unknown }).error
      const reason = typeof errField === "string" ? errField : "unknown"
      throw new Error(`slack ${method}: ${reason}`)
    }
    return raw
  }

  private async post(method: string, body: Record<string, unknown>): Promise<unknown> {
    return await this.fetchSlackApi(method, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.props.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    })
  }

  private async postForm(method: string, body: Record<string, unknown>): Promise<unknown> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(body)) {
      if (value === null || value === undefined) continue
      params.set(key, formValue(value))
    }

    return await this.fetchSlackApi(method, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.props.botToken}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: params.toString(),
    })
  }

  private async postExternalFile(uploadUrl: string, args: SlackFileUpload): Promise<void> {
    const timeoutMs = this.props.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const form = new FormData()
    const content = new ArrayBuffer(args.content.byteLength)
    new Uint8Array(content).set(args.content)
    form.append("file", new Blob([content]), args.filename)

    try {
      const fetchFn = this.props.fetchFn ?? globalThis.fetch
      const response = await fetchFn(uploadUrl, {
        method: "POST",
        body: form,
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`slack file upload http ${response.status}`)
      await response.body?.cancel().catch(() => undefined)
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`slack file upload timed out after ${timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** POST once; on a 429 honor Retry-After and retry exactly once. No general
   * retry loop — a second 429 surfaces as the plain http error. */
  private async fetchSlackApi(method: string, init: RequestInit): Promise<unknown> {
    const first = await this.fetchAttempt(method, init, true)
    const retryAfterMs = first.retryAfterMs
    if (retryAfterMs === null) return first.value

    await new Promise((resolve) => setTimeout(resolve, retryAfterMs))

    const retried = await this.fetchAttempt(method, init, false)
    return retried.value
  }

  private async fetchAttempt(
    method: string,
    init: RequestInit,
    captureRateLimit: boolean,
  ): Promise<{ retryAfterMs: number | null; value: unknown }> {
    const timeoutMs = this.props.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const fetchFn = this.props.fetchFn ?? globalThis.fetch
      const response = await fetchFn(`${SLACK_API_BASE}/${method}`, {
        ...init,
        signal: controller.signal,
      })

      if (captureRateLimit && response.status === 429) {
        const retryAfterMs = slackRateLimitDelayMs(response.headers.get("retry-after"))
        await response.body?.cancel().catch(() => undefined)
        return { retryAfterMs, value: undefined }
      }

      const value = await this.parseHttpResponse(method, response)
      return { retryAfterMs: null, value }
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`slack ${method} timed out after ${timeoutMs}ms`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  private async parseHttpResponse(method: string, response: Response): Promise<unknown> {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`slack ${method} http ${response.status} ${response.statusText}`)
    }

    return await readJsonResponse(response, method)
  }
}

const readJsonResponse = async (response: Response, method: string): Promise<unknown> => {
  const declaredLength = response.headers.get("content-length")
  const parsedLength = declaredLength === null ? null : Number(declaredLength)
  if (parsedLength !== null && Number.isFinite(parsedLength) && parsedLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw responseTooLarge(method)
  }

  const body = response.body
  if (body === null) throw new Error(`slack ${method}: response body is empty`)
  const chunks = await readBoundedChunks(body.getReader(), [], 0, method)
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`slack ${method}: response is not valid JSON`)
  }
}

const readBoundedChunks = async (
  reader: ByteReader,
  chunks: Uint8Array[],
  byteLength: number,
  method: string,
): Promise<Uint8Array[]> => {
  const next = await reader.read()
  if (next.done) return chunks

  const chunk = next.value
  const nextByteLength = byteLength + chunk.byteLength
  if (nextByteLength > MAX_RESPONSE_BYTES) {
    await reader.cancel().catch(() => undefined)
    throw responseTooLarge(method)
  }
  chunks.push(chunk)
  return await readBoundedChunks(reader, chunks, nextByteLength, method)
}

type ByteReader = {
  read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>
  cancel(): Promise<void>
}

const responseTooLarge = (method: string): Error => {
  return new Error(
    `slack ${method}: response exceeded ${MAX_RESPONSE_BYTES} bytes; retry with a smaller limit, cursor, or filter`,
  )
}

const FORM_ENCODED_METHODS = new Set([
  "conversations.history",
  "conversations.info",
  "conversations.list",
  "conversations.replies",
  "files.getUploadURLExternal",
  "search.messages",
])

const formValue = (value: unknown): string => {
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

const authTestSchema = z
  .object({
    user_id: z.string().optional(),
  })
  .passthrough()

const slackExternalUploadSchema = z.object({
  upload_url: z.string(),
  file_id: z.string(),
})

const conversationsInfoSchema = z
  .object({
    channel: z
      .object({
        is_member: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough()

const historyMessageSchema = z
  .object({
    user: z.string().optional(),
    text: z.string().optional(),
    ts: z.string().optional(),
    thread_ts: z.string().optional(),
    reply_count: z.number().int().nonnegative().optional(),
    subtype: z.string().optional(),
    bot_id: z.string().optional(),
  })
  .passthrough()

const historySchema = z
  .object({
    messages: z.array(historyMessageSchema).default([]),
  })
  .passthrough()

const conversationsListSchema = z
  .object({
    channels: z
      .array(
        z
          .object({
            id: z.string().optional(),
            is_im: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
    response_metadata: z
      .object({
        next_cursor: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const searchMessagesSchema = z
  .object({
    messages: z
      .object({
        matches: z
          .array(
            z
              .object({
                channel: z.object({ id: z.string().optional() }).passthrough().optional(),
                user: z.string().optional(),
                text: z.string().optional(),
                ts: z.string().optional(),
                permalink: z.string().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
