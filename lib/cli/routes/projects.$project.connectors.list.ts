import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"
import type { ConnectorConfig } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> connectors / manage connectors

usage / leuco projects <p> connectors [subcommand]

subcommands:
  (none) / list every connector
  add (slack|schedule) / add a connector
  <c> / connector operations (run \`leuco projects <p> connectors <c> -h\`)`

export const connectorsListHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)

  return c.text(
    renderYaml({
      connectors: project.connectors.map((ch) => ({
        name: ch.name,
        type: ch.type,
        enabled: ch.enabled,
        ...describeChannelExtra(ch),
      })),
    }),
  )
})

const describeChannelExtra = (ch: ConnectorConfig): Record<string, unknown> => {
  if (ch.type === "slack") {
    return { tokensSet: ch.botToken.length > 0 && ch.appToken.length > 0 }
  }

  if (ch.type === "schedule") {
    return { entries: ch.entries.length }
  }

  return {}
}
