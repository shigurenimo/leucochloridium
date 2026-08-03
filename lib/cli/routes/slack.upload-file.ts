import { basename, resolve } from "node:path"
import { HTTPException } from "hono/http-exception"
import { readBoundedUploadFile } from "@/actions/slack/read-bounded-upload-file"
import { resolveSlackTokens } from "@/actions/slack/slack-call"
import { factory } from "@/cli/cli-factory"
import { resolveProjectArgument } from "@/cli/utils/lookup-config"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { LeucoProjectStore } from "@/projects/project-store"

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

const help = `leuco slack upload-file / upload a local file through the stored Slack connector

usage / leuco slack upload-file --channel <id> --file <path> [--thread-ts <ts>]
          [--title <title>] [--comment <text>] [--project <p>] [--connector <c>]

options:
  --channel <id> / destination Slack conversation id
  --file <path> / local file to upload
  --thread-ts <ts> / optional destination thread timestamp
  --title <title> / Slack file title; defaults to the file name
  --comment <text> / optional message posted with the file
  --project <p> / project whose stored bot token is used
  --connector <c> / Slack connector name when the project has multiple`

export const slackUploadFileHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const rawFilePath = flagString(body.flags.file)
  const channelId = flagString(body.flags.channel)
  if (rawFilePath === null) throw new HTTPException(400, { message: "--file is required" })
  if (channelId === null) throw new HTTPException(400, { message: "--channel is required" })

  const filePath = resolve(c.var.cwd, rawFilePath)
  const uploadFile = await readBoundedUploadFile({ path: filePath, maxBytes: MAX_UPLOAD_BYTES })
  if (!uploadFile.isFile) throw new HTTPException(400, { message: "--file must be a file" })
  if (uploadFile.exceedsLimit) {
    throw new HTTPException(400, { message: `--file exceeds ${MAX_UPLOAD_BYTES} bytes` })
  }

  const projectName = flagString(body.flags.project)
  const connectorName = flagString(body.flags.connector) ?? undefined
  const store = new LeucoProjectStore()
  const project = resolveProjectArgument(c, store, projectName)
  const tokens = resolveSlackTokens({ project, connectorName })
  const filename = basename(filePath)
  const client = new LeucoFetchSlackWebClient({ botToken: tokens.botToken })
  const uploaded = await client.filesUpload({
    content: uploadFile.content,
    filename,
    title: flagString(body.flags.title) ?? filename,
    channelId,
    threadTs: flagString(body.flags["thread-ts"]),
    initialComment: flagString(body.flags.comment),
  })

  return c.text(`uploaded: ${uploaded.fileId}`)
})
