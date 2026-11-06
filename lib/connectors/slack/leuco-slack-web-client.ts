/**
 * Outbound port for the connector's Slack Web API calls (authTest and reactions).
 * Real traffic goes through `LeucoFetchSlackWebClient`; tests substitute
 * `LeucoMemorySlackWebClient`. The `leuco slack call` action constructs the fetch
 * implementation directly.
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
