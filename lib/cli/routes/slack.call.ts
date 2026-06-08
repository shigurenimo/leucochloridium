import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { resolveSlackTokens, slackCall } from "@/actions/slack/slack-call"
import { factory } from "@/cli/cli-factory"
import { findAgent, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import { errorMessage } from "@/error-message"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco slack call — forward a Slack Web API call

usage: leuco slack call <method> [--body '<json>'] --project <p> --agent <a> [--channel <c>]

  <method>            Slack Web API method, e.g. chat.postMessage, conversations.replies
  --body '<json>'     JSON body for the method (default: {})
  --project <p>       project name registered in ~/.leuco/projects/
  --agent <a>         agent name within that project
  --channel <c>       leuco channel name (only needed if the agent has multiple)

Outputs the raw Slack JSON response on stdout. See the slack_call MCP tool
for the codex-side equivalent.`

export const slackCallHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const method = body.args[0]
  if (!method) {
    throw new HTTPException(400, {
      message:
        "usage: leuco slack call <method> [--body '<json>'] --project <p> --agent <a> [--channel <c>]",
    })
  }

  const projectName = flagString(body.flags.project)
  const agentName = flagString(body.flags.agent)
  if (!projectName || !agentName) {
    throw new HTTPException(400, { message: "--project and --agent are required" })
  }

  const channelName = flagString(body.flags.channel) ?? undefined
  const rawBody = flagString(body.flags.body)
  const parsedBody = parseJsonBody(rawBody)

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  const agent = findAgent(project, agentName)
  const tokens = resolveSlackTokens({ project, agent, channelName })
  const result = await slackCall({ botToken: tokens.botToken, method, body: parsedBody })

  return c.text(JSON.stringify(result, null, 2))
})

const parseJsonBody = (raw: string | null): Record<string, unknown> => {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new HTTPException(400, { message: `--body: ${errorMessage(err)}` })
  }
  const validated = jsonBodySchema.safeParse(parsed)
  if (!validated.success) {
    throw new HTTPException(400, { message: "--body: must be a JSON object" })
  }
  return validated.data
}

const jsonBodySchema = z.record(z.string(), z.unknown())
