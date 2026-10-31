export const pendingNotificationMaxRecords = 1000
export const pendingNotificationMaxBytes = 1024 * 1024

export class CodexPendingNotifications {
  private readonly entries: Array<{ method: string; serialized: string }> = []
  private readonly state = { bytes: 0 }

  constructor() {
    Object.freeze(this)
  }

  push(method: string, params: unknown): void {
    const serialized = JSON.stringify(params)
    if (typeof serialized !== "string") throw new Error("Codex notification is not JSON")
    const bytes = Buffer.byteLength(method) + Buffer.byteLength(serialized)
    if (
      this.entries.length + 1 > pendingNotificationMaxRecords ||
      this.state.bytes + bytes > pendingNotificationMaxBytes
    ) {
      throw Object.assign(
        new Error(
          `Codex pending turn notifications exceeded limit: ${this.entries.length + 1} records, ${this.state.bytes + bytes} bytes (maximum ${pendingNotificationMaxRecords} records / ${pendingNotificationMaxBytes} bytes)`,
        ),
        { code: "CODEX_PENDING_NOTIFICATION_LIMIT" },
      )
    }
    this.entries.push({ method, serialized })
    this.state.bytes += bytes
  }

  drain(): Array<{ method: string; params: unknown }> {
    const entries = this.entries.splice(0)
    this.state.bytes = 0
    return entries.map((entry) => {
      const params: unknown = JSON.parse(entry.serialized)
      return { method: entry.method, params }
    })
  }

  clear(): void {
    this.entries.splice(0)
    this.state.bytes = 0
  }
}
