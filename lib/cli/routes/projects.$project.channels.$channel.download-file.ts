import { resolve } from "node:path"
import { HTTPException } from "hono/http-exception"
import { slackDownloadFile } from "@/actions/slack/slack-download-file"
import { slackResolveFileDownloadUrl } from "@/actions/slack/slack-resolve-file-download-url"
import { factory } from "@/cli/cli-factory"
import { findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> channels <c> download-file / download a private Slack file

usage / leuco projects <p> channels <c> download-file (--file <id>|--url <url>) --out <path>

options:
  --file <id> / Slack file id; resolves url_private_download via files.info
  --url <url> / Slack url_private or url_private_download
  --out <path> / output file path`

export const channelsDownloadFileHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const rawOutputPath = flagString(body.flags.out)
  if (!rawOutputPath) {
    throw new HTTPException(400, { message: "--out is required" })
  }
  // Resolve against the caller's cwd like every other path-taking route —
  // a relative --out must not land in whatever directory the process
  // happens to run in when LEUCO_CWD points elsewhere.
  const outputPath = resolve(c.var.cwd, rawOutputPath)

  const projectName = c.req.param("project")!
  const channelName = c.req.param("channel")!
  const botToken = resolveSlackBotToken({ projectName, channelName, cwd: c.var.cwd })
  const fileUrl = await resolveFileUrl({
    botToken,
    fileId: flagString(body.flags.file),
    directUrl: flagString(body.flags.url),
  })
  const result = await slackDownloadFile({
    botToken,
    url: fileUrl,
    outputPath,
  })

  return c.text(`saved: ${result.outputPath}\nsize: ${result.size}`)
})

type ResolveSlackBotTokenProps = {
  projectName: string
  channelName: string
  cwd: string
}

const resolveSlackBotToken = (props: ResolveSlackBotTokenProps): string => {
  const store = new LeucoProjectStore()
  const project = resolveProject(store, props.projectName, { preferCwd: props.cwd })
  const channel = findChannel(project, props.channelName)

  if (channel.type !== "slack") {
    throw new HTTPException(400, {
      message: `channel "${props.channelName}" is not a slack channel`,
    })
  }

  return channel.botToken
}

type ResolveFileUrlProps = {
  botToken: string
  fileId: string | null
  directUrl: string | null
}

const resolveFileUrl = async (props: ResolveFileUrlProps): Promise<string> => {
  if (props.directUrl !== null && props.fileId !== null) {
    throw new HTTPException(400, { message: "use either --file or --url, not both" })
  }

  if (props.directUrl !== null) return props.directUrl

  if (props.fileId === null) {
    throw new HTTPException(400, { message: "one of --file or --url is required" })
  }

  return await slackResolveFileDownloadUrl({
    botToken: props.botToken,
    fileId: props.fileId,
  })
}
