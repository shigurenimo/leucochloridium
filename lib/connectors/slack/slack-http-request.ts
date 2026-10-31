import { awaitAbortableOperation } from "@/await-abortable-operation"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { errorMessage } from "@/error-message"
import { MAX_TIMER_DELAY_MS } from "@/timer-limits"

type Props = {
  url: string
  init: RequestInit
  label: string
  timeoutMs: number
  signal?: AbortSignal
  fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}
type Outcome<T> = { completed: true; value: T } | { completed: false; error: unknown }

/** Own the response until parsing and bounded cleanup both finish. */
export class SlackHttpRequest {
  constructor(private readonly props: Props) {
    Object.freeze(this)
  }

  async run<T>(consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeoutMs = this.props.timeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS)
      throw new Error(
        `Slack request timeout must be whole milliseconds between 1 and ${MAX_TIMER_DELAY_MS}`,
      )
    const controller = new AbortController()
    const signal = this.props.signal
      ? AbortSignal.any([this.props.signal, controller.signal])
      : controller.signal
    signal.throwIfAborted()
    const timer = setTimeout(
      () => controller.abort(new Error(`${this.props.label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    const owned: { response: Response | null } = { response: null }
    const outcome = await (async (): Promise<Outcome<T>> => {
      try {
        owned.response = await awaitAbortableOperation(
          this.props.fetchFn(this.props.url, {
            ...this.props.init,
            signal,
          }),
          signal,
        )
        const value = await consume(owned.response, signal)
        signal.throwIfAborted()
        return { completed: true, value }
      } catch (error) {
        const primary = signal.aborted ? signal.reason : error
        return {
          completed: false,
          error:
            primary === error
              ? error
              : new AggregateError([primary, error], errorMessage(primary), { cause: primary }),
        }
      } finally {
        clearTimeout(timer)
      }
    })()
    try {
      await awaitBoundedCleanup(
        Promise.resolve().then(async () => {
          await owned.response?.body?.cancel()
        }),
        "Slack response cancellation",
      )
    } catch (cleanup) {
      if (!outcome.completed)
        throw new AggregateError(
          [outcome.error, cleanup],
          `${errorMessage(outcome.error)}; response cleanup failed`,
          { cause: outcome.error },
        )
      throw new Error(
        `${this.props.label} http ${owned.response?.status}: response cleanup failed; do not replay automatically`,
        { cause: cleanup },
      )
    }
    if (!outcome.completed) throw outcome.error
    signal.throwIfAborted()
    return outcome.value
  }
}
