import { factory } from "@/cli/cli-factory"
import { findAgent, findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { resolveTokenFlag } from "@/cli/utils/resolve-token-flag"
import type { Channel } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> channels <c> set-tokens — update Slack tokens on a channel

usage: leuco projects <p> agents <a> channels <c> set-tokens [--bot-token <t>] [--app-token <t>]

  --bot-token <token | ->     Slack bot OAuth token (xoxb-…). Pass \`-\` to read from stdin.
  --app-token <token | ->     Slack app-level token (xapp-…). Pass \`-\` to read from stdin.

At least one flag is required. Omitted flags keep the existing value. Restart
the agent (\`leuco projects <p> agents <a> restart\`) so the tenant rebuilds with
the new tokens.`

export const channelsSetTokensHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const channelName = c.req.param("channel")!

  const botFlag = body.flags["bot-token"]
  const appFlag = body.flags["app-token"]

  if (typeof botFlag !== "string" && typeof appFlag !== "string") {
    return c.text("leuco: at least one of --bot-token / --app-token is required", 400)
  }

  if (botFlag === "-" && appFlag === "-") {
    return c.text("leuco: only one of --bot-token / --app-token can read from stdin", 400)
  }

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  const channel = findChannel(agent, projectName, channelName)
  if (channel instanceof Error) return c.text(`leuco: ${channel.message}`, 404)

  if (channel.type !== "slack") {
    return c.text(`leuco: channel ${channelName} is not a slack channel`, 400)
  }

  const nextBotToken = (await resolveTokenFlag(botFlag)) ?? channel.botToken
  const nextAppToken = (await resolveTokenFlag(appFlag)) ?? channel.appToken

  const next: Channel = { ...channel, botToken: nextBotToken, appToken: nextAppToken }

  const saved = store.save({
    ...project,
    agents: project.agents.map((a) =>
      a.name !== agentName
        ? a
        : {
            ...a,
            channels: a.channels.map((ch) => (ch.name === channelName ? next : ch)),
          },
    ),
  })
  if (saved instanceof Error) return c.text(`leuco: ${saved.message}`, 500)

  const updated: string[] = []
  if (typeof botFlag === "string") updated.push("botToken")
  if (typeof appFlag === "string") updated.push("appToken")

  return c.text(
    `updated ${updated.join(", ")} for ${projectName}/${agentName}/${channelName}\nrestart the agent for the daemon to pick up the change.`,
  )
})
