import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { waitForTenantDown } from "@/cli/utils/wait-for-tenant-down"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"
import type { Project } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> channels <c> restart / reload a channel

usage / leuco projects <p> channels <c> restart [--force]

Toggles enabled false->true around two SIGHUPs. Rebuilds the whole tenant
(codex + all channels). Use to pick up token or config changes.

options:
  --force / allow restarting the channel from inside its parent Codex session`

export const channelsRestartHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const channelName = c.req.param("channel")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  if (!flagBool(body.flags.force) && isCurrentCodexProject(project)) {
    throw new HTTPException(400, {
      message: selfProjectGuardMessage(projectName, `restart channel "${channelName}" for`),
    })
  }

  const channel = findChannel(project, channelName)

  const wasEnabled = channel.enabled

  // Patch through updateProject so the daemon's concurrent state writes
  // (codexThreadId, scheduleLastFiredAt) are never rolled back by a stale
  // snapshot of the whole project.
  const setChannelEnabled = (enabled: boolean): void => {
    store.updateProject(project.id, (fresh): Project => {
      return {
        ...fresh,
        channels: fresh.channels.map((ch) => (ch.name === channelName ? { ...ch, enabled } : ch)),
      }
    })
  }

  setChannelEnabled(false)
  const stopReload = c.var.daemon.reload()

  const confirmedDown = stopReload.signalled ? await waitForTenantDown(project.id) : true

  setChannelEnabled(true)
  const reload = c.var.daemon.reload()

  const tail = wasEnabled ? "" : " (was disabled; ended up enabled)"
  const reloadMsg = reload.signalled ? "(daemon reloaded)" : "(daemon not running)"
  const warn = confirmedDown
    ? ""
    : "\nwarning: tenant did not stop within 10s; the restart may not have taken effect"
  return c.text(`restarted channel "${channelName}"${tail} ${reloadMsg}${warn}`)
})
