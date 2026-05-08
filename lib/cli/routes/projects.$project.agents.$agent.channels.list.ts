import { factory } from "@/cli/cli-factory"
import { findAgent } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import type { Channel } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> channels list — list channels under an agent

usage: leuco projects <p> agents <a> channels list

Prints each channel on its own line, with the env var names referenced for
its tokens (the tokens themselves are not stored in config).`

export const channelsListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!

  const store = new LeucoProjectStore()
  const project = store.load(projectName)
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  if (agent.channels.length === 0) return c.text("(no channels)")

  const lines = agent.channels.map((ch) => {
    const state = ch.enabled ? "enabled" : "disabled"
    const status = describeChannelStatus(ch)
    return `${ch.name}\t${ch.type}\t${state}${status}`
  })

  return c.text(lines.join("\n"))
})

const describeChannelStatus = (ch: Channel): string => {
  if (ch.type === "slack") {
    return ch.botToken.length > 0 && ch.appToken.length > 0 ? "" : "\t(tokens empty)"
  }

  if (ch.type === "schedule") {
    return `\t(${ch.entries.length} entries)`
  }

  return ""
}
