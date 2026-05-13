import { randomUUID } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import pkg from "../../package.json" with { type: "json" }
import { validateRunAt } from "@/channels/schedule/validate-run-at"
import { findAgent } from "@/cli/utils/lookup-config"
import { validateLeucoName } from "@/cli/utils/validate-name"
import { resolveSlackTokens, slackCall } from "@/actions/slack/slack-call"
import type { ScheduleChannel, ScheduleEntry } from "@/config/config-schema"
import {
  formatZodIssue,
  scheduleCreateArgsSchema,
  scheduleDeleteArgsSchema,
  scheduleListArgsSchema,
  slackCallArgsSchema,
} from "@/mcp/mcp-tool-schemas"
import { LeucoProjectStore } from "@/projects/project-store"

type Props = {
  projectName: string
  agentName: string
  store?: LeucoProjectStore
}

const TOOL_SLACK_CALL = "slack_call"
const TOOL_SCHEDULE_CREATE = "schedule_create"
const TOOL_SCHEDULE_LIST = "schedule_list"
const TOOL_SCHEDULE_DELETE = "schedule_delete"

const SLACK_CALL_DESCRIPTION = [
  "Forward a Slack Web API call (e.g. chat.postMessage, conversations.replies,",
  "reactions.add, files.upload). The body is the API method's JSON body — see",
  "https://api.slack.com/methods for parameters. Tokens are scoped to this",
  "agent's enabled Slack channel; passing `channel_name` selects between",
  "multiple channels owned by the same agent.",
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
        "Optional leuco-side channel identifier when the agent has multiple slack channels. Defaults to the first enabled one.",
    },
  },
}

const SCHEDULE_CREATE_DESCRIPTION = [
  "Register a scheduled prompt that the daemon will deliver back to this agent",
  "at the specified time. `run_at` is either an ISO 8601 timestamp (one-shot,",
  "deleted after fire) or a 5-field cron expression (recurring). The daemon",
  "picks up new entries on the next minute tick — no restart needed. If the",
  "agent owns multiple schedule channels, pass `channel_name` to disambiguate.",
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
      description: "Prompt text the daemon will deliver back to this agent when the entry fires.",
    },
    channel_name: {
      type: "string",
      description: "Optional schedule channel name when the agent owns more than one.",
    },
  },
}

const SCHEDULE_LIST_DESCRIPTION =
  "List schedule entries owned by the current agent. If `channel_name` is omitted and the agent has multiple schedule channels, every channel's entries are returned."

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
  "Delete a schedule entry by id or by name. If the agent owns multiple schedule channels, pass `channel_name` to disambiguate."

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
      description: "Optional schedule channel name when the agent owns more than one.",
    },
  },
}

/**
 * Build an MCP `Server` bound to one (project, agent) pair. Shared by the
 * stdio entry (`startMcpServer`) and the gateway's streamable HTTP route, so
 * tool definitions and handlers stay in one place.
 *
 * The (project, agent) identity is locked in at build time: this server only
 * ever acts on behalf of that tenant's Slack tokens, so a leaked tool call
 * cannot reach another tenant's surface.
 */
export const buildMcpServer = (props: Props): Server => {
  const store = props.store ?? new LeucoProjectStore()
  const handlerProps: HandlerProps = {
    projectName: props.projectName,
    agentName: props.agentName,
    store,
  }

  const server = new Server(
    { name: `leuco/${props.projectName}/${props.agentName}`, version: pkg.version },
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

    if (name === TOOL_SLACK_CALL) return handleSlackCall(handlerProps, args)
    if (name === TOOL_SCHEDULE_CREATE) return handleScheduleCreate(handlerProps, args)
    if (name === TOOL_SCHEDULE_LIST) return handleScheduleList(handlerProps, args)
    if (name === TOOL_SCHEDULE_DELETE) return handleScheduleDelete(handlerProps, args)

    return errorResponse(`unknown tool: ${name}`)
  })

  return server
}

type HandlerProps = {
  projectName: string
  agentName: string
  store: LeucoProjectStore
}

const handleSlackCall = async (props: HandlerProps, args: unknown) => {
  const parsed = slackCallArgsSchema.safeParse(args)
  if (!parsed.success) return errorResponse(formatZodIssue(parsed.error))

  const tokens = resolveTenantTokens({
    store: props.store,
    projectName: props.projectName,
    agentName: props.agentName,
    channelName: parsed.data.channel_name,
  })
  if (tokens instanceof Error) return errorResponse(tokens.message)

  const result = await slackCall({
    botToken: tokens.botToken,
    method: parsed.data.method,
    body: parsed.data.body ?? {},
  })
  if (result instanceof Error) return errorResponse(result.message)

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
}

const handleScheduleCreate = async (props: HandlerProps, args: unknown) => {
  const parsed = scheduleCreateArgsSchema.safeParse(args)
  if (!parsed.success) return errorResponse(formatZodIssue(parsed.error))

  const validatedName = validateLeucoName(parsed.data.name, "schedule entry name")
  if (validatedName instanceof Error) return errorResponse(validatedName.message)

  const validatedRunAt = validateRunAt(parsed.data.run_at)
  if (validatedRunAt instanceof Error) return errorResponse(validatedRunAt.message)

  const channel = resolveScheduleChannel({
    store: props.store,
    projectName: props.projectName,
    agentName: props.agentName,
    channelName: parsed.data.channel_name,
  })
  if (channel instanceof Error) return errorResponse(channel.message)

  const entry: ScheduleEntry = {
    id: randomUUID(),
    name: validatedName,
    runAt: validatedRunAt,
    prompt: parsed.data.prompt,
    enabled: true,
  }

  const result = props.store.addScheduleEntry({
    projectName: props.projectName,
    agentName: props.agentName,
    channelName: channel.name,
    entry,
  })
  if (result instanceof Error) return errorResponse(result.message)

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

  const project = props.store.load(props.projectName)
  if (project instanceof Error) return errorResponse(project.message)

  const agent = findAgent(project, props.agentName)
  if (agent instanceof Error) return errorResponse(agent.message)

  const channels = agent.channels.filter(
    (c): c is ScheduleChannel =>
      c.type === "schedule" && (!channelNameArg || c.name === channelNameArg),
  )

  if (channels.length === 0) {
    return errorResponse(
      channelNameArg
        ? `schedule channel '${channelNameArg}' not found in ${props.projectName}/${props.agentName}`
        : `${props.projectName}/${props.agentName} has no schedule channel`,
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
    projectName: props.projectName,
    agentName: props.agentName,
    channelName: parsed.data.channel_name,
  })
  if (channel instanceof Error) return errorResponse(channel.message)

  const result = props.store.removeScheduleEntry({
    projectName: props.projectName,
    agentName: props.agentName,
    channelName: channel.name,
    entryIdOrName: parsed.data.id_or_name,
  })
  if (result instanceof Error) return errorResponse(result.message)

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
  projectName: string
  agentName: string
  channelName?: string
}): ScheduleChannel | Error => {
  const project = input.store.load(input.projectName)
  if (project instanceof Error) return project

  const agent = findAgent(project, input.agentName)
  if (agent instanceof Error) return agent

  const channels = agent.channels.filter((c): c is ScheduleChannel => c.type === "schedule")

  if (input.channelName !== undefined) {
    const match = channels.find((c) => c.name === input.channelName)
    if (!match) {
      return new Error(
        `schedule channel '${input.channelName}' not found in ${input.projectName}/${input.agentName}`,
      )
    }
    return match
  }

  if (channels.length === 0) {
    return new Error(`${input.projectName}/${input.agentName} has no schedule channel`)
  }
  if (channels.length > 1) {
    const names = channels.map((c) => c.name).join(", ")
    return new Error(
      `multiple schedule channels exist (${names}); pass \`channel_name\` to disambiguate`,
    )
  }
  return channels[0]!
}

const resolveTenantTokens = (input: {
  store: LeucoProjectStore
  projectName: string
  agentName: string
  channelName?: string
}): { botToken: string; channelName: string } | Error => {
  const project = input.store.load(input.projectName)
  if (project instanceof Error) return project

  const agent = findAgent(project, input.agentName)
  if (agent instanceof Error) return agent

  const tokens = resolveSlackTokens({ project, agent, channelName: input.channelName })
  if (tokens instanceof Error) return tokens
  return { botToken: tokens.botToken, channelName: tokens.channelName }
}

const errorResponse = (
  message: string,
): { content: { type: "text"; text: string }[]; isError: true } => ({
  content: [{ type: "text", text: message }],
  isError: true,
})
