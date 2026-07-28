import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { resolveSlackTokens, slackCall } from "@/actions/slack/slack-call"
import { factory } from "@/cli/cli-factory"
import { resolveProjectArgument } from "@/cli/utils/lookup-config"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import { toBoundedJson } from "@/cli/utils/to-bounded-json"
import { errorMessage } from "@/error-message"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco slack call / forward a Slack Web API call

usage / leuco slack call <method> [--project <p>] [--body '<json>'] [--connector <c>]

options:
  <method> / Slack Web API method (e.g. chat.postMessage)
  --body '<json>' / JSON body for the method (default: {})
  --project <p> / project whose stored bot token is used; optional inside a
                  project runtime Codex session and required otherwise
  --connector <c> / pick a specific Slack connector when the project has multiple

output / bounded Slack JSON response`

export const slackCallHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const method = body.args[0]
  if (!method) {
    throw new HTTPException(400, {
      message:
        "usage: leuco slack call <method> [--body '<json>'] [--project <p>] [--connector <c>]",
    })
  }
  const parsedMethod = slackMethodSchema.safeParse(method)
  if (!parsedMethod.success) {
    throw new HTTPException(400, {
      message: "<method>: must be a dotted Slack API method name",
    })
  }

  const projectName = flagString(body.flags.project)
  const connectorName = flagString(body.flags.connector) ?? undefined
  const rawBody = flagString(body.flags.body)
  const parsedBody = parseJsonBody(rawBody)

  const store = new LeucoProjectStore()
  const project = resolveProjectArgument(c, store, projectName)
  const tokens = resolveSlackTokens({ project, connectorName })
  const result = await slackCall({
    botToken: tokens.botToken,
    method: parsedMethod.data,
    body: parsedBody,
  })

  return c.text(toBoundedJson(result))
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
const slackMethodSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/)
