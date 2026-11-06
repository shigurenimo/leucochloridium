type Props = {
  hardTimeoutMs: number
  idleTimeoutMs: number
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
    const hardError = new Error(
      `codex turn hard deadline exceeded after ${props.hardTimeoutMs / 1000}s`,
    )
    this.idleError = new Error(
      `codex turn idle timeout after ${props.idleTimeoutMs / 1000}s without activity`,
    )
    this.hardTimeout = new Promise((resolve) => {
      this.hardTimer = setTimeout(() => resolve(hardError), props.hardTimeoutMs)
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
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.armIdle()
  }

  clear(): void {
    this.isCleared = true
    if (this.hardTimer !== null) clearTimeout(this.hardTimer)
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.hardTimer = null
    this.idleTimer = null
  }

  private armIdle(): void {
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.isIdleExpired = true
      this.resolveIdle(this.idleError)
    }, this.props.idleTimeoutMs)
  }
}
