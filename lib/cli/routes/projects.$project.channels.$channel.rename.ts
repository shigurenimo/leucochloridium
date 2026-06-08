import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { validateLeucoName } from "@/cli/utils/validate-name"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> channels <c> rename / change a channel's identifier

usage / leuco projects <p> channels <c> rename <new-name>

The channel's UUID and tokens stay untouched.`

export const channelsRenameHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const oldName = c.req.param("channel")!
  const newName = body.args[0]
  if (!newName) {
    throw new HTTPException(400, {
      message: `usage: leuco projects ${projectName} channels ${oldName} rename <new-name>`,
    })
  }
  if (newName === oldName) {
    throw new HTTPException(400, { message: `new name is identical to current name (${oldName})` })
  }

  validateLeucoName(newName, "channel name")

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  findChannel(project, oldName)

  if (project.channels.some((ch) => ch.name === newName)) {
    throw new HTTPException(400, {
      message: `channel already exists in ${projectName}: ${newName}`,
    })
  }

  store.save({
    ...project,
    channels: project.channels.map((ch) => (ch.name === oldName ? { ...ch, name: newName } : ch)),
  })

  const lines = [`renamed channel "${oldName}" to "${newName}"`]
  const reloaded = c.var.daemon.reload()
  if (reloaded.signalled) lines.push(`daemon reloaded (pid ${reloaded.pid})`)

  return c.text(lines.join("\n"))
})
