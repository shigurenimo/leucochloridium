import { LeucoSlackSockets } from "@/connectors/slack/leuco-slack-sockets"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"

type SocketEntry = {
  socket: WebSocket
  closed: ReturnType<typeof Promise.withResolvers<void>>
  timer: ReturnType<typeof setTimeout> | null
}

export class LeucoNodeSlackSockets extends LeucoSlackSockets {
  private readonly entries = new Set<SocketEntry>()
  private isClosing = false
  private forcedCloses = 0
  readonly WebSocket: new (url: string | URL) => WebSocket

  constructor() {
    super()
    const assertOpen = () => {
      if (this.isClosing) throw new Error("Slack socket session is closing")
    }
    const register = (entry: SocketEntry) => this.entries.add(entry)
    const complete = (entry: SocketEntry) => this.entries.delete(entry)
    const recordForcedClose = () => {
      this.forcedCloses += 1
    }
    this.WebSocket = class extends WebSocket {
      private readonly entry: SocketEntry

      constructor(url: string | URL) {
        assertOpen()
        super(url)
        this.entry = { socket: this, closed: Promise.withResolvers<void>(), timer: null }
        register(this.entry)
        void this.entry.closed.promise.catch(() => undefined)
        this.addEventListener(
          "close",
          () => {
            if (this.entry.timer !== null) clearTimeout(this.entry.timer)
            complete(this.entry)
            this.entry.closed.resolve()
          },
          { once: true },
        )
      }

      override close(code?: number, reason?: string): void {
        super.close(code, reason)
        if (this.readyState === WebSocket.CLOSED || this.entry.timer !== null) return
        this.entry.timer = setTimeout(() => {
          this.entry.timer = null
          try {
            recordForcedClose()
            this.terminate()
          } catch (error) {
            this.entry.closed.reject(error)
          }
        }, 1000)
      }
    }
  }

  async close(): Promise<number> {
    this.isClosing = true
    const entries = [...this.entries]
    const failures: unknown[] = []
    for (const entry of entries) {
      try {
        entry.socket.close()
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      const outcomes = await awaitBoundedCleanup(
        Promise.allSettled(entries.map((entry) => entry.closed.promise)),
        "Slack WebSocket shutdown",
        2000,
      )
      for (const outcome of outcomes)
        if (outcome.status === "rejected") failures.push(outcome.reason)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Slack WebSocket shutdown was not confirmed", {
        cause: failures[0],
      })
    return this.forcedCloses
  }
}
