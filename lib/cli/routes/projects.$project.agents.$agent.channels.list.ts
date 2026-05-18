import { factory } from "@/cli/cli-factory"
import { findAgent, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import type { Channel } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> channels — list channels under an agent

usage:
  leuco projects <p> agents <a> channels                  list channels under this agent
  leuco projects <p> agents <a> channels add slack        add a slack channel
  leuco projects <p> agents <a> channels <c> remove       remove a channel
  leuco projects <p> agents <a> channels <c> rename <new> rename a channel
  leuco projects <p> agents <a> channels <c> schedules    manage schedule entries

Each row prints \`<name> <tab> <type> <tab> <state>\` plus a per-type status
suffix (\`(tokens empty)\` for slack, \`(<n> entries)\` for schedule).

Run \`leuco projects <p> agents <a> channels <subcommand> -h\` for details on a specific subcommand.`

export const channelsListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  const agent = findAgent(project, agentName)

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
