import { HTTPException } from "hono/http-exception"
import { randomUUID } from "node:crypto"
import type { Context } from "hono"
import { assertRoutableName } from "@/cli/utils/assert-routable-name"
import { factory, type Env } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { type CliBody, flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { resolveTokenFlag } from "@/cli/utils/resolve-token-flag"
import { slackAppTokenSchema, slackBotTokenSchema } from "@/channels/slack/slack-schemas"
import type { Channel } from "@/config/config-schema"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> channels add / register a channel

usage / leuco projects <p> channels add (slack|schedule) [options]

options:
  --name <name> / channel identifier (default: <type>)
  --bot-token <token | -> / [slack] bot/user OAuth token (xoxb- or xoxp-). \`-\` reads from stdin.
  --app-token <token | -> / [slack] app-level token (xapp-...). \`-\` reads from stdin.

examples:
  leuco projects demo channels add slack --bot-token xoxb-... --app-token xapp-...
  leuco projects demo channels add schedule`

export const channelsAddHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const type = body.args[0]

  if (type !== "slack" && type !== "schedule") {
    throw new HTTPException(400, {
      message: `usage: leuco projects ${projectName} channels add (slack|schedule) [...]\n  unsupported type: ${type ?? "(missing)"}`,
    })
  }

  if (type === "slack") return addSlackChannel(c, body, projectName)
  return addScheduleChannel(c, body, projectName)
})

const addSlackChannel = async (c: Context<Env>, body: CliBody, projectName: string) => {
  if (body.flags["bot-token"] === "-" && body.flags["app-token"] === "-") {
    throw new HTTPException(400, {
      message: "only one of --bot-token / --app-token can read from stdin",
    })
  }

  // Validate before saving: readSettings() re-parses names against safeName
  // on every load, so persisting an invalid name would brick every command.
  const channelName = assertRoutableName(
    typeof body.flags.name === "string" ? body.flags.name : "slack",
    "channel name",
  )
  const botToken = (await resolveTokenFlag(body.flags["bot-token"])) ?? ""
  const appToken = (await resolveTokenFlag(body.flags["app-token"])) ?? ""
  validateSlackTokens({ botToken, appToken })

  const store = new LeucoProjectStore({ paths: new LeucoPaths() })
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  if (project.channels.some((ch) => ch.name === channelName)) {
    throw new HTTPException(400, {
      message: `leuco: channel already exists in ${projectName}: ${channelName}`,
    })
  }

  const channelId = randomUUID()
  const next: Channel = {
    id: channelId,
    name: channelName,
    type: "slack",
    enabled: true,
    botToken,
    appToken,
    ackMode: "off",
    ackIcons: {
      progress: "hourglass_flowing_sand",
      success: "white_check_mark",
      error: "x",
    },
  }

  store.updateProject(project.id, (fresh) => ({ ...fresh, channels: [...fresh.channels, next] }))
  const saved = store.getPaths().settingsPath()

  const tail =
    botToken.length > 0 && appToken.length > 0
      ? "tokens recorded; run `leuco run` to start."
      : `edit ${saved} (or run \`leuco projects ${projectName} channels ${channelName} set-tokens\`) to fill in any missing tokens.`

  return c.text(`added channel "${channelName}" (slack, id: ${channelId})\n${tail}`)
}

const validateSlackTokens = (input: { botToken: string; appToken: string }): void => {
  if (input.botToken.length > 0) {
    const parsed = slackBotTokenSchema.safeParse(input.botToken)
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: `--bot-token ${parsed.error.issues[0]?.message}`,
      })
    }
  }
  if (input.appToken.length > 0) {
    const parsed = slackAppTokenSchema.safeParse(input.appToken)
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: `--app-token ${parsed.error.issues[0]?.message}`,
      })
    }
  }
}

const addScheduleChannel = async (c: Context<Env>, body: CliBody, projectName: string) => {
  const channelName = assertRoutableName(
    typeof body.flags.name === "string" ? body.flags.name : "schedule",
    "channel name",
  )

  const store = new LeucoProjectStore({ paths: new LeucoPaths() })
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  if (project.channels.some((ch) => ch.name === channelName)) {
    throw new HTTPException(400, {
      message: `leuco: channel already exists in ${projectName}: ${channelName}`,
    })
  }

  const channelId = randomUUID()
  const next: Channel = {
    id: channelId,
    name: channelName,
    type: "schedule",
    enabled: true,
    entries: [],
  }

  store.updateProject(project.id, (fresh) => ({ ...fresh, channels: [...fresh.channels, next] }))

  return c.text(
    `added channel "${channelName}" (schedule, id: ${channelId})\nadd entries with \`leuco projects ${projectName} channels ${channelName} schedules add\`.`,
  )
}
