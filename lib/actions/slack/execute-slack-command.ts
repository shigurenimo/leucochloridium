import { MAX_FILE_TRANSFER_BYTES } from "@/file-transfer-limits"
import { basename } from "node:path"
import { z } from "zod"
import type { CliArguments } from "@/cli/parse-arguments"
import { requiredCliFlag } from "@/cli/required-cli-flag"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { fetchSlackFile } from "@/actions/slack/fetch-slack-file"
import { assertSlackFileResponse } from "@/actions/slack/assert-slack-file-response"
import { slackResolveFileDownloadUrl } from "@/actions/slack/slack-resolve-file-download-url"

type Props = { parsed: CliArguments; botToken: string; upload?: Uint8Array; signal?: AbortSignal }
export async function executeSlackCommand(props: Props): Promise<unknown> {
  const parsed = props.parsed
  const botToken = props.botToken
  props.signal?.throwIfAborted()
  const action = parsed.words[1]
  if (action === "call") {
    const method = parsed.words[2]
    if (!method || !/^[a-zA-Z][a-zA-Z0-9.]+$/.test(method))
      throw new Error("A Slack API method is required")
    const body = z
      .custom<Record<string, unknown>>(
        (value) => value !== null && typeof value === "object" && !Array.isArray(value),
      )
      .parse(JSON.parse(requiredCliFlag(parsed, "body")))
    const client = new LeucoFetchSlackWebClient({ botToken, signal: props.signal })
    return await client.apiCall(method, body)
  }
  if (action === "upload-file") {
    const filename = basename(requiredCliFlag(parsed, "file"))
    const content = props.upload
    if (content === undefined || content.byteLength > MAX_FILE_TRANSFER_BYTES)
      throw new Error("Upload content is missing or exceeds 100 MiB")
    const client = new LeucoFetchSlackWebClient({ botToken: botToken, signal: props.signal })
    return client.filesUpload({
      content,
      filename,
      title: optional(parsed, "title") ?? filename,
      channelId: requiredCliFlag(parsed, "channel"),
      threadTs: optional(parsed, "thread-ts"),
      initialComment: optional(parsed, "comment"),
    })
  }
  if (action === "download-file") {
    const url = await slackResolveFileDownloadUrl({
      botToken: botToken,
      fileId: requiredCliFlag(parsed, "file"),
      signal: props.signal,
    })
    const response = await fetchSlackFile(url, botToken, 60000, props.signal)
    await assertSlackFileResponse(response)
    return new Response(response.body, { headers: { "content-type": "application/octet-stream" } })
  }
  throw new Error("Usage: leuco slack call | upload-file | download-file")
}

function optional(parsed: CliArguments, name: string): string | null {
  const value = parsed.flags[name]
  return typeof value === "string" ? value : null
}
