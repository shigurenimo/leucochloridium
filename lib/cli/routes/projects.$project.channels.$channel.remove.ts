import { factory } from "@/cli/cli-factory"
import { findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> channels <c> remove / drop a channel

usage / leuco projects <p> channels <c> remove

Removes the channel entry from settings.json.`

export const channelsRemoveHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const channelName = c.req.param("channel")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  findChannel(project, channelName)

  store.save({
    ...project,
    channels: project.channels.filter((ch) => ch.name !== channelName),
  })

  return c.text(`removed channel "${channelName}"`)
})
