import { assertSlackFileUrl } from "@/actions/slack/assert-slack-file-url"
import { awaitAbortableOperation } from "@/await-abortable-operation"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { errorMessage } from "@/error-message"
import { MAX_TIMER_DELAY_MS } from "@/timer-limits"

/** Validate every redirect before attaching a token; share one deadline across all response headers. */
export const fetchSlackFile = async (
  url: string,
  botToken: string,
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<Response> => new SlackFileFetch({ url, botToken, timeoutMs, signal }).run()

type Props = { url: string; botToken: string; timeoutMs: number; signal?: AbortSignal }
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** One response owner and one deadline across all authenticated redirect hops. */
class SlackFileFetch {
  private readonly controller = new AbortController()
  private readonly signal: AbortSignal
  private readonly current: {
    url: string
    remainingHops: number
    response: Response | null
    cancellation: Promise<void> | null
  }

  constructor(private readonly props: Props) {
    this.signal = props.signal
      ? AbortSignal.any([props.signal, this.controller.signal])
      : this.controller.signal
    this.current = {
      url: props.url,
      remainingHops: 3,
      response: null,
      cancellation: null,
    }
    Object.freeze(this)
  }

  async run(): Promise<Response> {
    if (
      !Number.isSafeInteger(this.props.timeoutMs) ||
      this.props.timeoutMs < 1 ||
      this.props.timeoutMs > MAX_TIMER_DELAY_MS
    )
      throw new Error(
        `Slack file timeout must be whole milliseconds between 1 and ${MAX_TIMER_DELAY_MS}`,
      )
    const timer = setTimeout(
      () =>
        this.controller.abort(
          new Error(`slack file download timed out after ${this.props.timeoutMs}ms`),
        ),
      this.props.timeoutMs,
    )
    try {
      return await this.followRedirects()
    } catch (error) {
      clearTimeout(timer)
      const primary = this.signal.aborted ? this.signal.reason : error
      const failures: unknown[] = [primary]
      if (error !== primary) failures.push(error)
      try {
        await this.cancelCurrentBody()
      } catch (cleanup) {
        failures.push(cleanup)
      }
      const unique = [...new Set(failures)]
      if (unique.length === 1) throw primary
      throw new AggregateError(
        unique,
        `${errorMessage(primary)}; additional redirect or cleanup failure`,
        { cause: primary },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private async followRedirects(): Promise<Response> {
    while (true) {
      this.signal.throwIfAborted()
      const url = assertSlackFileUrl(this.current.url)
      const response = await awaitAbortableOperation(
        fetch(url, {
          headers: { Authorization: `Bearer ${this.props.botToken}` },
          redirect: "manual",
          signal: this.signal,
        }),
        this.signal,
      )
      this.current.response = response
      this.current.cancellation = null
      if (!REDIRECT_STATUSES.has(response.status)) {
        this.current.response = null
        return response
      }
      const next = this.nextUrl(response, url)
      await awaitAbortableOperation(this.cancelCurrentBody(), this.signal)
      this.signal.throwIfAborted()
      this.current.response = null
      this.current.cancellation = null
      this.current.url = next
      this.current.remainingHops -= 1
    }
  }

  private nextUrl(response: Response, url: URL): string {
    if (this.current.remainingHops === 0)
      throw new Error(`too many redirects downloading slack file: ${url.origin}${url.pathname}`)
    const location = response.headers.get("location")
    if (location === null)
      throw new Error(
        `redirect ${response.status} without location header: ${url.origin}${url.pathname}`,
      )
    return assertSlackFileUrl(location, url).toString()
  }

  private async cancelCurrentBody(): Promise<void> {
    const response = this.current.response
    if (response === null) return
    if (this.current.cancellation === null)
      this.current.cancellation = awaitBoundedCleanup(
        Promise.resolve().then(async () => {
          await response.body?.cancel()
        }),
        "redirect body cancellation",
      )
    await this.current.cancellation
  }
}
