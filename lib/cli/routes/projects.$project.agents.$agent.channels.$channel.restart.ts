import { factory } from "@/cli/cli-factory"
import { findAgent, findChannel } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import type { Project } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const RECONCILE_GAP_MS = 400

const help = `leuco projects <p> agents <a> channels <c> restart — reload a channel

usage: leuco projects <p> agents <a> channels <c> restart

Toggles the channel's \`enabled\` flag false → true around two SIGHUPs.
Because plugins are owned by the agent's tenant, this rebuilds the whole
tenant — codex process and all. Use it to pick up token / ackMode /
ackIcons changes for the channel.

The channel is briefly disconnected from Slack during the restart. The
agent's codex thread id (settings.json) is preserved.`

export const channelsRestartHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const channelName = c.req.param("channel")!

  const store = new LeucoProjectStore()
  const project = store.load(projectName)
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  const channel = findChannel(agent, projectName, channelName)
  if (channel instanceof Error) return c.text(`leuco: ${channel.message}`, 404)

  const wasEnabled = channel.enabled

  const setChannelEnabled = (enabled: boolean): Project => ({
    ...project,
    agents: project.agents.map((a) =>
      a.name === agentName
        ? {
            ...a,
            channels: a.channels.map((ch) =>
              ch.name === channelName ? { ...ch, enabled } : ch,
            ),
          }
        : a,
    ),
  })

  const offSave = store.save(setChannelEnabled(false))
  if (offSave instanceof Error) return c.text(`leuco: ${offSave.message}`, 500)
  c.var.daemon.reload()

  await new Promise((resolve) => setTimeout(resolve, RECONCILE_GAP_MS))

  const onSave = store.save(setChannelEnabled(true))
  if (onSave instanceof Error) return c.text(`leuco: ${onSave.message}`, 500)
  const reload = c.var.daemon.reload()

  const tail = wasEnabled ? "" : " (was disabled; ended up enabled)"
  const reloadMsg = reload.signalled ? "(daemon reloaded)" : "(daemon not running)"
  return c.text(
    `restarted channel ${projectName}/${agentName}/${channelName}${tail} ${reloadMsg}`,
  )
})
