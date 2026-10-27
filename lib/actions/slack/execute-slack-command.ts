import { basename } from "node:path"
import { z } from "zod"
import type { CliArguments } from "@/cli/parse-arguments"
import { required } from "@/cli/manage-settings"
import { slackCall } from "@/actions/slack/slack-call"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { fetchSlackFile } from "@/actions/slack/fetch-slack-file"
import { slackResolveFileDownloadUrl } from "@/actions/slack/slack-resolve-file-download-url"

type Props = { parsed: CliArguments; botToken: string; upload?: Uint8Array }
export async function executeSlackCommand(props: Props): Promise<unknown> {
  const parsed = props.parsed
  const botToken = props.botToken
  const action = parsed.words[1]
  if (action === "call") {
    const method = parsed.words[2]
    if (!method || !/^[a-zA-Z][a-zA-Z0-9.]+$/.test(method))
      throw new Error("A Slack API method is required")
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(required(parsed, "body")))
    const reply = await slackCall({ botToken: botToken, method, body })
    if (typeof reply === "object" && reply !== null && "ok" in reply && reply.ok === false) {
      throw new Error("error" in reply ? `Slack: ${String(reply.error)}` : "Slack API failed")
    }
    return reply
  }
  if (action === "upload-file") {
    const filename = basename(required(parsed, "file"))
    const content = props.upload
    if (content === undefined || content.byteLength > 100 * 1024 * 1024)
      throw new Error("Upload content is missing or exceeds 100 MiB")
    const client = new LeucoFetchSlackWebClient({ botToken: botToken })
    return client.filesUpload({
      content,
      filename,
      title: optional(parsed, "title") ?? filename,
      channelId: required(parsed, "channel"),
      threadTs: optional(parsed, "thread-ts"),
      initialComment: optional(parsed, "comment"),
    })
  }
  if (action === "download-file") {
    const url = await slackResolveFileDownloadUrl({
      botToken: botToken,
      fileId: required(parsed, "file"),
    })
    const response = await fetchSlackFile(url, botToken)
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error("Slack file download failed")
    }
    return new Response(response.body, { headers: { "content-type": "application/octet-stream" } })
  }
  throw new Error("Usage: leuco slack call | upload-file | download-file")
}

function optional(parsed: CliArguments, name: string): string | null {
  const value = parsed.flags[name]
  return typeof value === "string" ? value : null
}
