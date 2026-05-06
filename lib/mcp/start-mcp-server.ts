import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { findAgent } from "@/cli/utils/lookup-config"
import { resolveSlackTokens, slackCall } from "@/actions/slack/slack-call"
import { LeucoProjectStore } from "@/projects/project-store"

type Props = {
  projectName: string
  agentName: string
}

const TOOL_NAME = "slack_call"

const TOOL_DESCRIPTION = [
  "Forward a Slack Web API call (e.g. chat.postMessage, conversations.replies,",
  "reactions.add, files.upload). The body is the API method's JSON body — see",
  "https://api.slack.com/methods for parameters. Tokens are scoped to this",
  "agent's enabled Slack channel; passing `channel_name` selects between",
  "multiple channels owned by the same agent.",
].join(" ")

const TOOL_INPUT_SCHEMA = {
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

/**
 * stdio-MCP entry. Spawned by codex via `[mcp_servers.leuco] command = "leuco"
 * args = ["mcp", "--project", "<p>", "--agent", "<a>"]`. Exposes a single
 * generic `slack_call` tool that lets the agent reach any Slack Web API
 * method using the channel's stored bot token.
 *
 * The agent identity is locked in at spawn time: this MCP server only ever
 * acts on behalf of the (project, agent) pair the parent codex tenant knows
 * about, so a leaked tool call cannot reach another tenant's tokens.
 */
export const startMcpServer = async (props: Props): Promise<void> => {
  const server = new Server(
    { name: `leuco/${props.projectName}/${props.agentName}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        inputSchema: TOOL_INPUT_SCHEMA,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TOOL_NAME) {
      return {
        content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
        isError: true,
      }
    }

    const args = (request.params.arguments ?? {}) as {
      method?: unknown
      body?: unknown
      channel_name?: unknown
    }

    if (typeof args.method !== "string" || args.method.length === 0) {
      return errorResponse("`method` is required and must be a non-empty string")
    }

    const channelName = typeof args.channel_name === "string" ? args.channel_name : undefined
    const body =
      args.body !== null && typeof args.body === "object" && !Array.isArray(args.body)
        ? (args.body as Record<string, unknown>)
        : {}

    const tokens = resolveTenantTokens({
      projectName: props.projectName,
      agentName: props.agentName,
      channelName,
    })
    if (tokens instanceof Error) return errorResponse(tokens.message)

    const result = await slackCall({ botToken: tokens.botToken, method: args.method, body })
    if (result instanceof Error) return errorResponse(result.message)

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

const resolveTenantTokens = (input: {
  projectName: string
  agentName: string
  channelName?: string
}): { botToken: string; channelName: string } | Error => {
  const store = new LeucoProjectStore()
  const project = store.load(input.projectName)
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
