import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { resolveTokenFlag } from "@/cli/utils/resolve-token-flag"
import { slackAppTokenSchema, slackBotTokenSchema } from "@/channels/slack/slack-schemas"
import type { Channel } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> channels <c> set-tokens / update Slack tokens

usage / leuco projects <p> channels <c> set-tokens [--bot-token <t>] [--app-token <t>]

options:
  --bot-token <token | -> / Slack bot/user OAuth token (xoxb- or xoxp-). \`-\` reads from stdin.
  --app-token <token | -> / Slack app-level token (xapp-...). \`-\` reads from stdin.

At least one flag is required. Omitted flags keep the existing value.
Restart the project afterwards to pick up the change.`

export const channelsSetTokensHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const channelName = c.req.param("channel")!

  const botFlag = body.flags["bot-token"]
  const appFlag = body.flags["app-token"]

  if (typeof botFlag !== "string" && typeof appFlag !== "string") {
    throw new HTTPException(400, {
      message: "at least one of --bot-token / --app-token is required",
    })
  }

  if (botFlag === "-" && appFlag === "-") {
    throw new HTTPException(400, {
      message: "only one of --bot-token / --app-token can read from stdin",
    })
  }

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  const channel = findChannel(project, channelName)

  if (channel.type !== "slack") {
    throw new HTTPException(400, { message: `channel "${channelName}" is not a slack channel` })
  }

  const nextBotToken = (await resolveTokenFlag(botFlag)) ?? channel.botToken
  const nextAppToken = (await resolveTokenFlag(appFlag)) ?? channel.appToken
  validateSlackTokens({ botToken: nextBotToken, appToken: nextAppToken })

  const next: Channel = { ...channel, botToken: nextBotToken, appToken: nextAppToken }

  // updateProject re-reads inside the settings lock, so a concurrent daemon
  // state write cannot clobber the new tokens (and vice versa).
  store.updateProject(project.id, (fresh) => ({
    ...fresh,
    channels: fresh.channels.map((ch) => (ch.name === channelName ? next : ch)),
  }))

  const updated: string[] = []
  if (typeof botFlag === "string") updated.push("botToken")
  if (typeof appFlag === "string") updated.push("appToken")

  return c.text(
    `updated ${updated.join(", ")} for "${channelName}"\nrestart the project for the daemon to pick up the change.`,
  )
})

const validateSlackTokens = (input: { botToken: string; appToken: string }): void => {
  if (input.botToken.length > 0) {
    const botToken = slackBotTokenSchema.safeParse(input.botToken)
    if (!botToken.success) {
      throw new HTTPException(400, {
        message: `--bot-token ${botToken.error.issues[0]?.message}`,
      })
    }
  }
  if (input.appToken.length > 0) {
    const appToken = slackAppTokenSchema.safeParse(input.appToken)
    if (!appToken.success) {
      throw new HTTPException(400, {
        message: `--app-token ${appToken.error.issues[0]?.message}`,
      })
    }
  }
}
