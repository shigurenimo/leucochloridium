/** Default hard limit for a single Codex turn. */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000

/** Default period without Codex notifications before a turn is considered stalled. */
export const DEFAULT_TURN_IDLE_TIMEOUT_MS = 2 * 60 * 1000

/** Maximum number of different conversation threads that may run at once per project. */
export const DEFAULT_TURN_CONCURRENCY = 4

/** Maximum number of turns retained while one project turn is already running. */
export const DEFAULT_TURN_QUEUE_MAX_ITEMS = 64

/** Maximum UTF-8 bytes retained across one project's pending turn queue. */
export const DEFAULT_TURN_QUEUE_MAX_BYTES = 256 * 1024

export type LeucoTurnTimeoutClock = {
  setTimeout(handler: () => void, timeoutMs: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

type Props = {
  hardTimeoutMs: number
  idleTimeoutMs: number
  clock: LeucoTurnTimeoutClock
}

/**
 * Owns the hard deadline for the whole tenant turn and the renewable idle
 * deadline for the Codex portion of that turn.
 */
export class LeucoTurnTimeouts {
  readonly hardTimeout: Promise<Error>
  readonly idleTimeout: Promise<Error>
  private readonly hardError: Error
  private readonly idleError: Error
  private hardTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private resolveIdle: (error: Error) => void = () => {}
  private isIdleStarted = false
  private isIdleExpired = false
  private isCleared = false

  constructor(private readonly props: Props) {
    this.hardError = new Error(
      `codex turn hard deadline exceeded after ${props.hardTimeoutMs / 1000}s`,
    )
    this.idleError = new Error(
      `codex turn idle timeout after ${props.idleTimeoutMs / 1000}s without activity`,
    )
    this.hardTimeout = new Promise((resolve) => {
      this.hardTimer = props.clock.setTimeout(() => resolve(this.hardError), props.hardTimeoutMs)
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

  isTimeout(value: string | Error): boolean {
    return value === this.hardError || value === this.idleError
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
