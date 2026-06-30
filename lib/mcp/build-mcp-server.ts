import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import pkg from "../../package.json" with { type: "json" }
import { slackDownloadFile } from "@/actions/slack/slack-download-file"
import { slackResolveFileDownloadUrl } from "@/actions/slack/slack-resolve-file-download-url"
import { resolveSlackTokens, slackCall } from "@/actions/slack/slack-call"
import { validateRunAt } from "@/channels/schedule/validate-run-at"
import { validateLeucoName } from "@/cli/utils/validate-name"
import type { ScheduleChannel, ScheduleEntry } from "@/config/config-schema"
import { errorMessage } from "@/error-message"
import {
  formatZodIssue,
  scheduleCreateArgsSchema,
  scheduleDeleteArgsSchema,
  scheduleListArgsSchema,
  slackCallArgsSchema,
  slackDownloadFileArgsSchema,
} from "@/mcp/mcp-tool-schemas"
import { LeucoProjectStore } from "@/projects/project-store"

type Props = {
  projectId: string
  store?: LeucoProjectStore
}

const TOOL_SLACK_CALL = "slack_call"
const TOOL_SLACK_DOWNLOAD_FILE = "slack_download_file"
const TOOL_SCHEDULE_CREATE = "schedule_create"
const TOOL_SCHEDULE_LIST = "schedule_list"
const TOOL_SCHEDULE_DELETE = "schedule_delete"

const SLACK_CALL_DESCRIPTION = [
  "Forward a Slack Web API call (e.g. chat.postMessage, conversations.replies,",
  "reactions.add, files.upload). The body is the API method's JSON body — see",
  "https://api.slack.com/methods for parameters. Tokens are scoped to this",
  "project's enabled Slack channel; passing `channel_name` selects between",
  "multiple channels owned by the same project.",
].join(" ")

const SLACK_CALL_INPUT_SCHEMA = {
  type: "object",
  required: ["method"],
  properties: {
    method: {
      type: "string",
      description: 'Slack API method name (e.g. "chat.postMessage").',
    },
    body: {
      type: "object",
      description: "JSON body forwarded as the method arguments. Empty {} if omitted.",
      additionalProperties: true,
    },
    channel_name: {
      type: "string",
      description:
        "Optional leuco-side channel identifier when the project has multiple slack channels. Defaults to the first enabled one.",
    },
  },
}

const SLACK_DOWNLOAD_FILE_DESCRIPTION = [
  "Download a Slack private file using this project's stored Slack bot token.",
  "Pass either `file_id` (resolved through files.info) or `url`",
  "(url_private/url_private_download). The tool writes the binary to",
  "`output_path`, or a temporary path when omitted, and returns the saved path.",
].join(" ")

const SLACK_DOWNLOAD_FILE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    file_id: {
      type: "string",
      description: "Slack file id, e.g. F0123. Mutually exclusive with `url`.",
    },
    url: {
      type: "string",
      description: "Slack url_private or url_private_download. Mutually exclusive with `file_id`.",
    },
    output_path: {
      type: "string",
      description: "Optional local output file path. Defaults to a temp file.",
    },
    channel_name: {
      type: "string",
      description:
        "Optional leuco-side channel identifier when the project has multiple slack channels.",
    },
  },
}

const SCHEDULE_CREATE_DESCRIPTION = [
  "Register a scheduled prompt that the daemon will deliver back to this project",
  "at the specified time. `run_at` is either an ISO 8601 timestamp (one-shot,",
  "deleted after fire) or a 5-field cron expression (recurring). The daemon",
  "picks up new entries on the next minute tick — no restart needed. If the",
  "project owns multiple schedule channels, pass `channel_name` to disambiguate.",
].join(" ")

const SCHEDULE_CREATE_INPUT_SCHEMA = {
  type: "object",
  required: ["name", "run_at", "prompt"],
  properties: {
    name: {
      type: "string",
      description:
        "Unique identifier within the channel (^[a-z][a-z0-9_-]*$). Used by `schedule_delete`.",
    },
    run_at: {
      type: "string",
      description:
        'ISO 8601 timestamp ("2026-05-08T09:00:00Z") for one-shot, or a 5-field cron expression ("0 9 * * *") for recurring.',
    },
    prompt: {
      type: "string",
      description: "Prompt text the daemon will deliver back to this project when the entry fires.",
    },
    channel_name: {
      type: "string",
      description: "Optional schedule channel name when the project owns more than one.",
    },
  },
}

const SCHEDULE_LIST_DESCRIPTION =
  "List schedule entries owned by the current project. If `channel_name` is omitted and the project has multiple schedule channels, every channel's entries are returned."

const SCHEDULE_LIST_INPUT_SCHEMA = {
  type: "object",
  properties: {
    channel_name: {
      type: "string",
      description: "Optional schedule channel name to filter by.",
    },
  },
}

const SCHEDULE_DELETE_DESCRIPTION =
  "Delete a schedule entry by id or by name. If the project owns multiple schedule channels, pass `channel_name` to disambiguate."

const SCHEDULE_DELETE_INPUT_SCHEMA = {
  type: "object",
  required: ["id_or_name"],
  properties: {
    id_or_name: {
      type: "string",
      description: "Entry UUID returned by `schedule_create` / `schedule_list`, or its name.",
    },
    channel_name: {
      type: "string",
      description: "Optional schedule channel name when the project owns more than one.",
    },
  },
}

export const buildMcpServer = (props: Props): Server => {
  const store = props.store ?? new LeucoProjectStore()
  const handlerProps: HandlerProps = {
    projectId: props.projectId,
    store,
  }

  const server = new Server(
    { name: `leuco/${props.projectId}`, version: pkg.version },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_SLACK_CALL,
        description: SLACK_CALL_DESCRIPTION,
        inputSchema: SLACK_CALL_INPUT_SCHEMA,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      {
        name: TOOL_SLACK_DOWNLOAD_FILE,
        description: SLACK_DOWNLOAD_FILE_DESCRIPTION,
        inputSchema: SLACK_DOWNLOAD_FILE_INPUT_SCHEMA,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      {
        name: TOOL_SCHEDULE_CREATE,
        description: SCHEDULE_CREATE_DESCRIPTION,
        inputSchema: SCHEDULE_CREATE_INPUT_SCHEMA,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: TOOL_SCHEDULE_LIST,
        description: SCHEDULE_LIST_DESCRIPTION,
        inputSchema: SCHEDULE_LIST_INPUT_SCHEMA,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: TOOL_SCHEDULE_DELETE,
        description: SCHEDULE_DELETE_DESCRIPTION,
        inputSchema: SCHEDULE_DELETE_INPUT_SCHEMA,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const args: unknown = request.params.arguments ?? {}

    try {
      if (name === TOOL_SLACK_CALL) return await handleSlackCall(handlerProps, args)
      if (name === TOOL_SLACK_DOWNLOAD_FILE) {
        return await handleSlackDownloadFile(handlerProps, args)
      }
      if (name === TOOL_SCHEDULE_CREATE) return await handleScheduleCreate(handlerProps, args)
      if (name === TOOL_SCHEDULE_LIST) return await handleScheduleList(handlerProps, args)
      if (name === TOOL_SCHEDULE_DELETE) return await handleScheduleDelete(handlerProps, args)
      return errorResponse(`unknown tool: ${name}`)
    } catch (err) {
      return errorResponse(errorMessage(err))
    }
  })

  return server
}

type HandlerProps = {
  projectId: string
  store: LeucoProjectStore
}

const handleSlackCall = async (props: HandlerProps, args: unknown) => {
  const parsed = slackCallArgsSchema.safeParse(args)
  if (!parsed.success) return errorResponse(formatZodIssue(parsed.error))

  const tokens = resolveTenantTokens({
    store: props.store,
    projectId: props.projectId,
    channelName: parsed.data.channel_name,
  })

  const result = await slackCall({
    botToken: tokens.botToken,
    method: parsed.data.method,
    body: parsed.data.body ?? {},
  })

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
}

const handleSlackDownloadFile = async (props: HandlerProps, args: unknown) => {
  const parsed = slackDownloadFileArgsSchema.safeParse(args)
  if (!parsed.success) return errorResponse(formatZodIssue(parsed.error))

  const tokens = resolveTenantTokens({
    store: props.store,
    projectId: props.projectId,
    channelName: parsed.data.channel_name,
  })

  const fileUrl =
    parsed.data.url ??
    (await resolveSlackDownloadUrlFromFileId({
      botToken: tokens.botToken,
      fileId: parsed.data.file_id,
    }))
  const outputPath = parsed.data.output_path ?? join(tmpdir(), `leuco-slack-${randomUUID()}`)
  const result = await slackDownloadFile({
    botToken: tokens.botToken,
    url: fileUrl,
    outputPath,
  })

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  }
}

const resolveSlackDownloadUrlFromFileId = async (props: {
  botToken: string
  fileId?: string
}): Promise<string> => {
  if (props.fileId === undefined) {
    throw new Error("one of `file_id` or `url` is required")
  }

  return await slackResolveFileDownloadUrl({
    botToken: props.botToken,
    fileId: props.fileId,
  })
}

const handleScheduleCreate = async (props: HandlerProps, args: unknown) => {
  const parsed = scheduleCreateArgsSchema.safeParse(args)
  if (!parsed.success) return errorResponse(formatZodIssue(parsed.error))

  const validatedName = validateLeucoName(parsed.data.name, "schedule entry name")
  const validatedRunAt = validateRunAt(parsed.data.run_at)
  const channel = resolveScheduleChannel({
    store: props.store,
    projectId: props.projectId,
    channelName: parsed.data.channel_name,
  })

  const entry: ScheduleEntry = {
    id: randomUUID(),
    name: validatedName,
    runAt: validatedRunAt,
    prompt: parsed.data.prompt,
    enabled: true,
  }

  props.store.addScheduleEntry({
    projectId: props.projectId,
    channelName: channel.name,
    entry,
  })

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ id: entry.id, name: entry.name, channel: channel.name }, null, 2),
      },
    ],
  }
}

const handleScheduleList = async (props: HandlerProps, args: unknown) => {
  const parsed = scheduleListArgsSchema.safeParse(args)
  if (!parsed.success) return errorResponse(formatZodIssue(parsed.error))
  const channelNameArg = parsed.data.channel_name

  const project = props.store.load(props.projectId)

  // Mirror `resolveScheduleChannel`: only enabled schedule channels are
  // addressable through MCP. Listing disabled channels would create the
  // illusion that `schedule_create` / `schedule_delete` could target them too.
  const channels = project.channels.filter(
    (c): c is ScheduleChannel =>
      c.type === "schedule" && c.enabled && (!channelNameArg || c.name === channelNameArg),
  )

  if (channels.length === 0) {
    throw new Error(
      channelNameArg
        ? `schedule channel '${channelNameArg}' not found (or disabled) in ${project.name}`
        : `${project.name} has no enabled schedule channel`,
    )
  }

  const items = channels.flatMap((channel) =>
    channel.entries.map((entry) => ({
      channel: channel.name,
      id: entry.id,
      name: entry.name,
      runAt: entry.runAt,
      enabled: entry.enabled,
      prompt: entry.prompt,
    })),
  )

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] }
}

const handleScheduleDelete = async (props: HandlerProps, args: unknown) => {
  const parsed = scheduleDeleteArgsSchema.safeParse(args)
  if (!parsed.success) return errorResponse(formatZodIssue(parsed.error))

  const channel = resolveScheduleChannel({
    store: props.store,
    projectId: props.projectId,
    channelName: parsed.data.channel_name,
  })

  props.store.removeScheduleEntry({
    projectId: props.projectId,
    channelName: channel.name,
    entryIdOrName: parsed.data.id_or_name,
  })

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ removed: parsed.data.id_or_name, channel: channel.name }, null, 2),
      },
    ],
  }
}

const resolveScheduleChannel = (input: {
  store: LeucoProjectStore
  projectId: string
  channelName?: string
}): ScheduleChannel => {
  const project = input.store.load(input.projectId)
  const channels = project.channels.filter(
    (c): c is ScheduleChannel => c.type === "schedule" && c.enabled,
  )

  if (input.channelName !== undefined) {
    const match = channels.find((c) => c.name === input.channelName)
    if (!match) {
      throw new Error(
        `schedule channel '${input.channelName}' not found (or disabled) in ${project.name}`,
      )
    }
    return match
  }

  if (channels.length === 0) {
    throw new Error(`${project.name} has no enabled schedule channel`)
  }
  if (channels.length > 1) {
    const names = channels.map((c) => c.name).join(", ")
    throw new Error(
      `multiple schedule channels exist (${names}); pass \`channel_name\` to disambiguate`,
    )
  }
  return channels[0]!
}

const resolveTenantTokens = (input: {
  store: LeucoProjectStore
  projectId: string
  channelName?: string
}): { botToken: string; channelName: string } => {
  const project = input.store.load(input.projectId)
  const tokens = resolveSlackTokens({ project, channelName: input.channelName })
  return { botToken: tokens.botToken, channelName: tokens.channelName }
}

const errorResponse = (
  message: string,
): { content: { type: "text"; text: string }[]; isError: true } => ({
  content: [{ type: "text", text: message }],
  isError: true,
})
