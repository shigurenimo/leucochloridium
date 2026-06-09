import { factory } from "@/cli/cli-factory"
import { findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { sleepReconcileGap } from "@/cli/utils/reconcile-gap"
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
    return c.text(selfProjectGuardMessage(projectName, `restart channel "${channelName}" for`), 400)
  }

  const channel = findChannel(project, channelName)

  const wasEnabled = channel.enabled

  const setChannelEnabled = (enabled: boolean): Project => ({
    ...project,
    channels: project.channels.map((ch) => (ch.name === channelName ? { ...ch, enabled } : ch)),
  })

  store.save(setChannelEnabled(false))
  c.var.daemon.reload()

  await sleepReconcileGap()

  store.save(setChannelEnabled(true))
  const reload = c.var.daemon.reload()

  const tail = wasEnabled ? "" : " (was disabled; ended up enabled)"
  const reloadMsg = reload.signalled ? "(daemon reloaded)" : "(daemon not running)"
  return c.text(`restarted channel "${channelName}"${tail} ${reloadMsg}`)
})
