/**
 * Outbound port for Slack Web API. The adapter and the `leuco slack call` action
 * depend on this abstract class. Real traffic goes through
 * `LeucoFetchSlackWebClient` (raw fetch over `https://slack.com/api/...`); tests
 * substitute `LeucoMemorySlackWebClient`.
 */
export abstract class LeucoSlackWebClient {
  abstract reactionsAdd(args: { channel: string; timestamp: string; name: string }): Promise<void>

  abstract reactionsRemove(args: {
    channel: string
    timestamp: string
    name: string
  }): Promise<void>

  abstract authTest(): Promise<SlackAuthTest>

  /** Capture bytes and destination fields before waiting for upload preparation. */
  abstract filesUpload(args: SlackFileUpload): Promise<{ fileId: string }>

  abstract apiCall(method: string, body: Record<string, unknown>): Promise<unknown>
}

export type SlackAuthTest = {
  userId: string | null
  botId?: string | null
}

export type SlackFileUpload = {
  content: Uint8Array
  filename: string
  title: string
  channelId: string
  threadTs: string | null
  initialComment: string | null
}
