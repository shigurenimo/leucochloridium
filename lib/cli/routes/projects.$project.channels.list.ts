import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"
import type { Channel } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> channels / manage channels

usage / leuco projects <p> channels [subcommand]

subcommands:
  (none) / list every channel
  add (slack|schedule) / add a channel
  <c> / channel operations (run \`leuco projects <p> channels <c> -h\`)`

export const channelsListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  return c.text(
    renderYaml({
      channels: project.channels.map((ch) => ({
        name: ch.name,
        type: ch.type,
        enabled: ch.enabled,
        ...describeChannelExtra(ch),
      })),
    }),
  )
})

const describeChannelExtra = (ch: Channel): Record<string, unknown> => {
  if (ch.type === "slack") {
    return { tokensSet: ch.botToken.length > 0 && ch.appToken.length > 0 }
  }

  if (ch.type === "schedule") {
    return { entries: ch.entries.length }
  }

  return {}
}
