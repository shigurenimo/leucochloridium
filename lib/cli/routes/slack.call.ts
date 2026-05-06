import { resolveSlackTokens, slackCall } from "@/actions/slack/slack-call"
import { factory } from "@/cli/cli-factory"
import { findAgent } from "@/cli/utils/lookup-config"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
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
    return c.text(
      "usage: leuco slack call <method> [--body '<json>'] --project <p> --agent <a> [--channel <c>]",
      400,
    )
  }

  const projectName = flagString(body.flags.project)
  const agentName = flagString(body.flags.agent)
  if (!projectName || !agentName) {
    return c.text("leuco: --project and --agent are required", 400)
  }

  const channelName = flagString(body.flags.channel) ?? undefined
  const rawBody = flagString(body.flags.body)
  const parsedBody = parseJsonBody(rawBody)
  if (parsedBody instanceof Error) return c.text(`leuco: --body: ${parsedBody.message}`, 400)

  const store = new LeucoProjectStore()
  const project = store.load(projectName)
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  const tokens = resolveSlackTokens({ project, agent, channelName })
  if (tokens instanceof Error) return c.text(`leuco: ${tokens.message}`, 400)

  const result = await slackCall({ botToken: tokens.botToken, method, body: parsedBody })
  if (result instanceof Error) return c.text(`leuco: ${result.message}`, 500)

  return c.text(JSON.stringify(result, null, 2))
})

const parseJsonBody = (raw: string | null): Record<string, unknown> | Error => {
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Error("must be a JSON object")
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof Error) return err
    return new Error(String(err))
  }
}
