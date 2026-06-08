import { HTTPException } from "hono/http-exception"
import { randomUUID } from "node:crypto"
import type { Context } from "hono"
import { factory, type Env } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { type CliBody, flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { resolveTokenFlag } from "@/cli/utils/resolve-token-flag"
import type { Channel } from "@/config/config-schema"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> channels add / register a channel

usage / leuco projects <p> channels add (slack|schedule) [options]

options:
  --name <name> / channel identifier (default: <type>)
  --bot-token <token | -> / [slack] bot OAuth token (xoxb-...). \`-\` reads from stdin.
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

  const channelName = typeof body.flags.name === "string" ? body.flags.name : "slack"
  const botToken = (await resolveTokenFlag(body.flags["bot-token"])) ?? ""
  const appToken = (await resolveTokenFlag(body.flags["app-token"])) ?? ""

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
    ackMode: "mention",
    ackIcons: {
      progress: "hourglass_flowing_sand",
      success: "white_check_mark",
      error: "x",
    },
  }

  const saved = store.save({ ...project, channels: [...project.channels, next] })

  const tail =
    botToken.length > 0 && appToken.length > 0
      ? "tokens recorded; run `leuco run` to start."
      : `edit ${saved} (or run \`leuco projects ${projectName} channels ${channelName} set-tokens\`) to fill in any missing tokens.`

  return c.text(`added channel "${channelName}" (slack, id: ${channelId})\n${tail}`)
}

const addScheduleChannel = async (c: Context<Env>, body: CliBody, projectName: string) => {
  const channelName = typeof body.flags.name === "string" ? body.flags.name : "schedule"

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

  store.save({ ...project, channels: [...project.channels, next] })

  return c.text(
    `added channel "${channelName}" (schedule, id: ${channelId})\nadd entries with \`leuco projects ${projectName} channels ${channelName} schedules add\`.`,
  )
}
