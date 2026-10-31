import { MAX_TIMER_DELAY_MS } from "@/timer-limits"

type LeucoTurnTimeoutClock = {
  setTimeout(handler: () => void, timeoutMs: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

type Props = {
  hardTimeoutMs: number
  idleTimeoutMs: number
  clock: LeucoTurnTimeoutClock
}

/**
 * Owns the hard deadline for the whole runtime turn and the renewable idle
 * deadline for the Codex portion of that turn.
 */
export class LeucoTurnTimeouts {
  readonly hardTimeout: Promise<Error>
  readonly idleTimeout: Promise<Error>
  private readonly idleError: Error
  private hardTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private resolveIdle: (error: Error) => void = () => {}
  private isIdleStarted = false
  private isIdleExpired = false
  private isCleared = false

  constructor(private readonly props: Props) {
    for (const milliseconds of [props.hardTimeoutMs, props.idleTimeoutMs]) {
      if (
        !Number.isSafeInteger(milliseconds) ||
        milliseconds < 1 ||
        milliseconds > MAX_TIMER_DELAY_MS
      )
        throw new Error(
          `Turn timeouts must be whole milliseconds between 1 and ${MAX_TIMER_DELAY_MS}`,
        )
    }
    const hardError = new Error(
      `codex turn hard deadline exceeded after ${props.hardTimeoutMs / 1000}s`,
    )
    this.idleError = new Error(
      `codex turn idle timeout after ${props.idleTimeoutMs / 1000}s without activity`,
    )
    this.hardTimeout = new Promise((resolve) => {
      this.hardTimer = props.clock.setTimeout(() => resolve(hardError), props.hardTimeoutMs)
    })
    this.idleTimeout = new Promise((resolve) => {
      this.resolveIdle = resolve
    })
  }

  startIdle(): void {
    if (this.isIdleStarted || this.isCleared) return
    this.isIdleStarted = true
    this.armIdle()
  }

  activity(): void {
    if (!this.isIdleStarted || this.isIdleExpired || this.isCleared) return
    if (this.idleTimer !== null) this.props.clock.clearTimeout(this.idleTimer)
    this.armIdle()
  }

  clear(): void {
    this.isCleared = true
    if (this.hardTimer !== null) this.props.clock.clearTimeout(this.hardTimer)
    if (this.idleTimer !== null) this.props.clock.clearTimeout(this.idleTimer)
    this.hardTimer = null
    this.idleTimer = null
  }

  private armIdle(): void {
    this.idleTimer = this.props.clock.setTimeout(() => {
      this.idleTimer = null
      this.isIdleExpired = true
      this.resolveIdle(this.idleError)
    }, this.props.idleTimeoutMs)
  }
}
