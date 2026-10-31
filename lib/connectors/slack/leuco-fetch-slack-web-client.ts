import { z } from "zod"
import { awaitAbortableDelay } from "@/await-abortable-delay"
import {
  LeucoSlackWebClient,
  type SlackAuthTest,
  type SlackFileUpload,
} from "@/connectors/slack/leuco-slack-web-client"
import { SlackHttpRequest } from "@/connectors/slack/slack-http-request"
import { readBoundedJsonResponse } from "@/read-bounded-json-response"
import { slackRateLimitDelayMs } from "@/connectors/slack/slack-rate-limit-delay"

type LeucoFetchSlackWebClientProps = {
  botToken: string
  requestTimeoutMs?: number
  fetchFn?: SlackFetchPort
  signal?: AbortSignal
}

type SlackFetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const SLACK_API_BASE = "https://slack.com/api"
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

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

  async reactionsAdd(args: { channel: string; timestamp: string; name: string }): Promise<void> {
    await this.apiCall("reactions.add", {
      channel: args.channel,
      timestamp: args.timestamp,
      name: args.name,
    })
  }

  async reactionsRemove(args: { channel: string; timestamp: string; name: string }): Promise<void> {
    await this.apiCall("reactions.remove", {
      channel: args.channel,
      timestamp: args.timestamp,
      name: args.name,
    })
  }

  async authTest(): Promise<SlackAuthTest> {
    const raw = await this.apiCall("auth.test", {})
    const parsed = authTestSchema.safeParse(raw)
    if (!parsed.success)
      throw new Error("slack auth.test: invalid identity response", { cause: parsed.error })
    return {
      userId: parsed.data.user_id,
      botId: parsed.data.bot_id ?? null,
    }
  }

  async filesUpload(args: SlackFileUpload): Promise<{ fileId: string }> {
    this.props.signal?.throwIfAborted()
    const file = { ...args, content: new Blob([new Uint8Array(args.content)]) }
    const prepared = await this.apiCall("files.getUploadURLExternal", {
      filename: file.filename,
      length: file.content.size,
    })
    const upload = slackExternalUploadSchema.safeParse(prepared)
    if (!upload.success)
      throw new Error("slack file upload: invalid prepare response", { cause: upload.error })

    await this.postExternalFile(upload.data.upload_url, file)

    const body: Record<string, unknown> = {
      files: [{ id: upload.data.file_id, title: file.title }],
      channel_id: file.channelId,
    }
    if (file.threadTs !== null) body.thread_ts = file.threadTs
    if (file.initialComment !== null) body.initial_comment = file.initialComment
    await this.apiCall("files.completeUploadExternal", body)

    return { fileId: upload.data.file_id }
  }

  async apiCall(method: string, body: Record<string, unknown>): Promise<unknown> {
    const parameters = Object.fromEntries(
      Object.entries(body).filter((entry) => entry[0] !== "token"),
    )
    const reply = FORM_ENCODED_METHODS.has(method)
      ? await this.postForm(method, parameters)
      : await this.post(method, parameters)
    if (typeof reply !== "object" || reply === null || Array.isArray(reply))
      throw new Error(`slack ${method}: response is not an object`)
    if (!("ok" in reply) || typeof reply.ok !== "boolean")
      throw new Error(`slack ${method}: response is missing a boolean ok flag`)
    if (!reply.ok) {
      const reason = "error" in reply && typeof reply.error === "string" ? reply.error : "unknown"
      throw new Error(`slack ${method}: ${reason}`)
    }
    return reply
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

  private async postExternalFile(
    uploadUrl: string,
    args: { filename: string; content: Blob },
  ): Promise<void> {
    const form = new FormData()
    form.append("file", args.content, args.filename)
    await new SlackHttpRequest({
      url: uploadUrl,
      init: { method: "POST", body: form, redirect: "error" },
      label: "slack file upload",
      timeoutMs: this.props.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      fetchFn: this.props.fetchFn ?? globalThis.fetch,
      signal: this.props.signal,
    }).run(async (response) => {
      if (!response.ok) throw new Error(`slack file upload http ${response.status}`)
    })
  }

  /** POST once; on a 429 honor Retry-After and retry exactly once. No general
   * retry loop — a second 429 surfaces as the plain http error. */
  private async fetchSlackApi(method: string, init: RequestInit): Promise<unknown> {
    const first = await this.fetchAttempt(method, init, true)
    const retryAfterMs = first.retryAfterMs
    if (retryAfterMs === null) return first.value

    await awaitAbortableDelay(retryAfterMs, this.props.signal)

    const retried = await this.fetchAttempt(method, init, false)
    return retried.value
  }

  private async fetchAttempt(
    method: string,
    init: RequestInit,
    captureRateLimit: boolean,
  ): Promise<{ retryAfterMs: number | null; value: unknown }> {
    return new SlackHttpRequest({
      url: `${SLACK_API_BASE}/${method}`,
      init: { ...init, redirect: "error" },
      label: `slack ${method}`,
      timeoutMs: this.props.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      fetchFn: this.props.fetchFn ?? globalThis.fetch,
      signal: this.props.signal,
    }).run(async (response, signal) => {
      if (captureRateLimit && response.status === 429) {
        return {
          retryAfterMs: slackRateLimitDelayMs(response.headers.get("retry-after")),
          value: undefined,
        }
      }
      if (!response.ok)
        throw new Error(`slack ${method} http ${response.status} ${response.statusText}`)
      const value = await readBoundedJsonResponse({
        response,
        label: `slack ${method}: response`,
        signal,
        maxBytes: 2 * 1024 * 1024,
        limitHint: "retry with a smaller limit, cursor, or filter",
      })
      return { retryAfterMs: null, value }
    })
  }
}

const FORM_ENCODED_METHODS = new Set([
  "conversations.history",
  "conversations.info",
  "conversations.list",
  "conversations.replies",
  "files.completeUploadExternal",
  "files.getUploadURLExternal",
  "search.messages",
])

const formValue = (value: unknown): string => {
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

const authTestSchema = z.object({
  user_id: z.string().regex(/\S/, "Slack user identity must not be blank"),
  bot_id: z.string().regex(/\S/, "Slack bot identity must not be blank").optional(),
})

const slackExternalUploadSchema = z.object({
  upload_url: z
    .string()
    .url()
    .regex(/^https:\/\//i, "Slack upload URL must use HTTPS"),
  file_id: z.string().regex(/\S/, "Slack file identity must not be blank"),
})
