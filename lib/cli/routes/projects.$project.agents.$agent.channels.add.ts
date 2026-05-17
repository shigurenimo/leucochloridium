import { HTTPException } from "hono/http-exception"
import { randomUUID } from "node:crypto"
import type { Context } from "hono"
import { factory, type Env } from "@/cli/cli-factory"
import { findAgent, resolveProject } from "@/cli/utils/lookup-config"
import { type CliBody, flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { resolveTokenFlag } from "@/cli/utils/resolve-token-flag"
import type { Channel } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> channels add — register a channel under an agent

usage:
  leuco projects <p> agents <a> channels add slack    [--name <name>] [--bot-token <t>] [--app-token <t>]
  leuco projects <p> agents <a> channels add schedule [--name <name>]

  slack                       Slack workspace, Socket Mode bot
  schedule                    timer-driven; entries fire prompts back at the agent
  --name <name>               channel identifier (default: <type>)
  --bot-token <token | ->     [slack] bot OAuth token (xoxb-…). Pass \`-\` to read from stdin.
  --app-token <token | ->     [slack] app-level token (xapp-…). Pass \`-\` to read from stdin.

Adds a channel entry into ~/.leuco/projects/<p>/settings.json (chmod 600). For
slack channels, tokens are written as-is when supplied; omitted flags leave
the field empty so you can set them later with \`channels <c> set-tokens\`. For
schedule channels, use \`channels <c> schedules add\` to register entries.`

export const channelsAddHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const type = body.args[0]

  if (type !== "slack" && type !== "schedule") {
    return c.text(
      `usage: leuco projects ${projectName} agents ${agentName} channels add (slack|schedule) [...]\n  unsupported type: ${type ?? "(missing)"}`,
      400,
    )
  }

  if (type === "slack") return addSlackChannel(c, body, { projectName, agentName })
  return addScheduleChannel(c, body, { projectName, agentName })
})

type AddContext = { projectName: string; agentName: string }

const addSlackChannel = async (c: Context<Env>, body: CliBody, ctx: AddContext) => {
  if (body.flags["bot-token"] === "-" && body.flags["app-token"] === "-") {
    throw new HTTPException(400, {
      message: "only one of --bot-token / --app-token can read from stdin",
    })
  }

  const channelName = typeof body.flags.name === "string" ? body.flags.name : "slack"
  const botToken = (await resolveTokenFlag(body.flags["bot-token"])) ?? ""
  const appToken = (await resolveTokenFlag(body.flags["app-token"])) ?? ""

  const store = new LeucoProjectStore()
  const project = store.load(ctx.projectName)

  const agent = findAgent(project, ctx.agentName)

  if (agent.channels.some((ch) => ch.name === channelName)) {
    return c.text(
      `leuco: channel already exists in ${ctx.projectName}/${ctx.agentName}: ${channelName}`,
      400,
    )
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

  const saved = store.save({
    ...project,
    agents: project.agents.map((a) =>
      a.name === ctx.agentName ? { ...a, channels: [...a.channels, next] } : a,
    ),
  })

  const tail =
    botToken.length > 0 && appToken.length > 0
      ? "tokens recorded; run `leuco run` to start."
      : `edit ${saved} (or run \`leuco projects ${ctx.projectName} agents ${ctx.agentName} channels ${channelName} set-tokens\`) to fill in any missing tokens.`

  return c.text(
    `added channel ${ctx.projectName}/${ctx.agentName}/${channelName} (slack, id=${channelId})\n${tail}`,
  )
}

const addScheduleChannel = async (c: Context<Env>, body: CliBody, ctx: AddContext) => {
  const channelName = typeof body.flags.name === "string" ? body.flags.name : "schedule"

  const store = new LeucoProjectStore()
  const project = store.load(ctx.projectName)

  const agent = findAgent(project, ctx.agentName)

  if (agent.channels.some((ch) => ch.name === channelName)) {
    return c.text(
      `leuco: channel already exists in ${ctx.projectName}/${ctx.agentName}: ${channelName}`,
      400,
    )
  }

  const channelId = randomUUID()
  const next: Channel = {
    id: channelId,
    name: channelName,
    type: "schedule",
    enabled: true,
    entries: [],
  }

  store.save({
    ...project,
    agents: project.agents.map((a) =>
      a.name === ctx.agentName ? { ...a, channels: [...a.channels, next] } : a,
    ),
  })

  return c.text(
    `added channel ${ctx.projectName}/${ctx.agentName}/${channelName} (schedule, id=${channelId})\nadd entries with \`leuco projects ${ctx.projectName} agents ${ctx.agentName} channels ${channelName} schedules add\`.`,
  )
}
