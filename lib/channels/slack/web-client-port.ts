/**
 * Minimal structural contract leuco needs from `@slack/web-api`'s `WebClient`.
 * Adapter and listener depend on this shape; tests substitute a fake.
 */
export type WebClientPort = {
  chat: {
    postMessage(args: { channel: string; thread_ts?: string; text: string }): Promise<unknown>
  }
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>
    remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>
  }
  conversations: {
    info(args: { channel: string }): Promise<unknown>
  }
  auth: {
    test(): Promise<unknown>
  }
}
