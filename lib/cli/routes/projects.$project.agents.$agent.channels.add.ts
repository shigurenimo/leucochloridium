import { randomUUID } from "node:crypto"
import { factory } from "@/cli/cli-factory"
import { findAgent } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { resolveTokenFlag } from "@/cli/utils/resolve-token-flag"
import type { Channel } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> channels add — register a chat channel under an agent

usage: leuco projects <p> agents <a> channels add slack [--name <name>] [--bot-token <t>] [--app-token <t>]

  slack                       only supported channel type today
  --name <name>               channel identifier (default: "slack")
  --bot-token <token | ->     Slack bot OAuth token (xoxb-…). Pass \`-\` to read from stdin.
  --app-token <token | ->     Slack app-level token (xapp-…). Pass \`-\` to read from stdin.

Adds a channel entry into ~/.leuco/projects/<p>/settings.json (chmod 600). Tokens
are written as-is when supplied; omitted flags leave the field empty so you can
set it later with \`leuco projects <p> agents <a> channels <c> set-tokens\` or by
editing the file directly. Run \`leuco run\` (or restart) once tokens are in.`

export const channelsAddHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const type = body.args[0]

  if (type !== "slack") {
    return c.text(
      `usage: leuco projects ${projectName} agents ${agentName} channels add slack [--name <name>] [--bot-token <t>] [--app-token <t>]\n  unsupported type: ${type ?? "(missing)"}`,
      400,
    )
  }

  if (body.flags["bot-token"] === "-" && body.flags["app-token"] === "-") {
    return c.text("leuco: only one of --bot-token / --app-token can read from stdin", 400)
  }

  const channelName = typeof body.flags.name === "string" ? body.flags.name : "slack"
  const botToken = (await resolveTokenFlag(body.flags["bot-token"])) ?? ""
  const appToken = (await resolveTokenFlag(body.flags["app-token"])) ?? ""

  const store = new LeucoProjectStore()
  const project = store.load(projectName)
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  if (agent.channels.some((ch) => ch.name === channelName)) {
    return c.text(
      `leuco: channel already exists in ${projectName}/${agentName}: ${channelName}`,
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
      a.name === agentName ? { ...a, channels: [...a.channels, next] } : a,
    ),
  })
  if (saved instanceof Error) return c.text(`leuco: ${saved.message}`, 500)

  const tail =
    botToken.length > 0 && appToken.length > 0
      ? "tokens recorded; run `leuco run` to start."
      : `edit ${saved} (or run \`leuco projects ${projectName} agents ${agentName} channels ${channelName} set-tokens\`) to fill in any missing tokens.`

  return c.text(
    `added channel ${projectName}/${agentName}/${channelName} (slack, id=${channelId})\n${tail}`,
  )
})
