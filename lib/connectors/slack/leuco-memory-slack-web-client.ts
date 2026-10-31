import {
  LeucoSlackWebClient,
  type SlackAuthTest,
  type SlackFileUpload,
} from "@/connectors/slack/leuco-slack-web-client"

type SlackMemoryResponder<T, A> = ((args: A) => Promise<T> | T) | T

type LeucoMemorySlackWebClientProps = {
  reactionsAdd?: SlackMemoryResponder<void, { channel: string; timestamp: string; name: string }>
  reactionsRemove?: SlackMemoryResponder<void, { channel: string; timestamp: string; name: string }>
  authTest?: SlackMemoryResponder<SlackAuthTest, void>
  filesUpload?: SlackMemoryResponder<{ fileId: string }, SlackFileUpload>
  apiCall?: SlackMemoryResponder<unknown, { method: string; body: Record<string, unknown> }>
}

/**
 * In-memory test double for `LeucoSlackWebClient`. Every method records the
 * call site for assertion (`calls.<method>`) and replies via the matching
 * `Props` field — either a fixed value or a function that takes the call args.
 */
export class LeucoMemorySlackWebClient extends LeucoSlackWebClient {
  readonly calls: {
    reactionsAdd: Array<{ channel: string; timestamp: string; name: string }>
    reactionsRemove: Array<{ channel: string; timestamp: string; name: string }>
    authTest: Array<void>
    filesUpload: SlackFileUpload[]
    apiCall: Array<{ method: string; body: Record<string, unknown> }>
  }

  constructor(private readonly props: LeucoMemorySlackWebClientProps = {}) {
    super()
    this.calls = {
      reactionsAdd: [],
      reactionsRemove: [],
      authTest: [],
      filesUpload: [],
      apiCall: [],
    }
  }

  async reactionsAdd(args: { channel: string; timestamp: string; name: string }): Promise<void> {
    this.calls.reactionsAdd.push(args)

    return this.invoke(this.props.reactionsAdd, args, undefined as void)
  }

  async reactionsRemove(args: { channel: string; timestamp: string; name: string }): Promise<void> {
    this.calls.reactionsRemove.push(args)

    return this.invoke(this.props.reactionsRemove, args, undefined as void)
  }

  async authTest(): Promise<SlackAuthTest> {
    this.calls.authTest.push(undefined as void)

    return this.invoke(this.props.authTest, undefined as void, { userId: null })
  }

  async filesUpload(args: SlackFileUpload): Promise<{ fileId: string }> {
    const file = { ...args, content: new Uint8Array(args.content) }
    this.calls.filesUpload.push(file)

    return this.invoke(this.props.filesUpload, file, { fileId: "F-memory" })
  }

  async apiCall(method: string, body: Record<string, unknown>): Promise<unknown> {
    const call = { method, body }
    this.calls.apiCall.push(call)

    return this.invoke(this.props.apiCall, call, { ok: true })
  }

  private async invoke<T, A>(
    responder: SlackMemoryResponder<T, A> | undefined,
    args: A,
    fallback: T,
  ): Promise<T> {
    if (responder === undefined) return fallback
    if (typeof responder === "function") {
      const fn = responder as (args: A) => Promise<T> | T
      return await fn(args)
    }
    return responder
  }
}
