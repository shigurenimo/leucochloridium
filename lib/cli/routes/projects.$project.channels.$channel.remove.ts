import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { stopProjectTenant } from "@/cli/utils/stop-project-tenant"
import { waitForTenantDown } from "@/cli/utils/wait-for-tenant-down"
import { errorMessage } from "@/error-message"
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

  const stopped = await stopProjectTenant({
    projectId: project.id,
    store,
    daemon: c.var.daemon,
    waitForDown: waitForTenantDown,
  })
  if (stopped instanceof Error) {
    throw new HTTPException(503, { message: stopped.message })
  }

  try {
    store.updateProject(project.id, (fresh) => ({
      ...fresh,
      enabled: stopped.disabledForStop ? true : fresh.enabled,
      channels: fresh.channels.filter((ch) => ch.name !== channelName),
    }))
  } catch (err) {
    if (stopped.disabledForStop) {
      try {
        store.updateProject(project.id, (fresh) => ({ ...fresh, enabled: true }))
        c.var.daemon.reload()
      } catch {
        // Preserve the mutation error.
      }
    }
    throw new HTTPException(500, { message: `channel remove failed: ${errorMessage(err)}` })
  }

  if (stopped.disabledForStop) {
    const reload = c.var.daemon.reload()
    if (!reload.signalled) {
      throw new HTTPException(503, {
        message: `channel removed but daemon restart signal failed for project '${project.name}'`,
      })
    }
  }

  const tail = stopped.disabledForStop ? " (tenant restarted)" : ""
  return c.text(`removed channel "${channelName}"${tail}`)
})
