import { randomUUID } from "node:crypto"
import { factory } from "@/cli/cli-factory"
import { findAgent } from "@/cli/utils/lookup-config"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import type { Channel } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> channels add — register a chat channel under an agent

usage: leuco projects <p> agents <a> channels add slack [--name <name>]

  slack            only supported channel type today
  --name <name>    channel identifier (default: "slack")

Adds a channel entry (with a fresh UUID, empty botToken/appToken) into
~/.leuco/projects/<p>/settings.json. Open that file (chmod 600) and paste your
Slack tokens into the channel's botToken and appToken fields, then \`leuco run\`.`

export const channelsAddHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const type = body.args[0]

  if (type !== "slack") {
    return c.text(
      `usage: leuco projects ${projectName} agents ${agentName} channels add slack [--name <name>]\n  unsupported type: ${type ?? "(missing)"}`,
      400,
    )
  }

  const channelName = flagString(body.flags.name) ?? "slack"

  const store = new LeucoProjectStore()
  const project = store.load(projectName)
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  if (agent.channels.some((ch) => ch.name === channelName)) {
    return c.text(`leuco: channel already exists in ${projectName}/${agentName}: ${channelName}`, 400)
  }

  const channelId = randomUUID()
  const next: Channel = {
    id: channelId,
    name: channelName,
    type: "slack",
    enabled: true,
    botToken: "",
    appToken: "",
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

  return c.text(
    [
      `added channel ${projectName}/${agentName}/${channelName} (slack, id=${channelId})`,
      `edit ${saved} and fill in botToken / appToken before \`leuco run\`.`,
    ].join("\n"),
  )
})
