import { factory } from "@/cli/cli-factory"
import { findAgent } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { sleepReconcileGap } from "@/cli/utils/reconcile-gap"
import type { Project } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> restart — rebuild a single agent's tenant

usage: leuco projects <p> agents <a> restart

Toggles the agent's \`enabled\` flag false → true around two SIGHUPs so the
daemon stops + rebuilds this tenant. Use this to pick up persona TOML edits,
token changes, ackMode / ackIcons updates, or to clear a stuck codex
process. The codex thread id is preserved in settings.json, so the
conversation history is resumed transparently.

The agent is briefly disconnected from Slack during the restart.`

export const agentsRestartHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!

  const store = new LeucoProjectStore()
  const project = store.load(projectName)
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  const wasEnabled = agent.enabled

  const setAgentEnabled = (enabled: boolean): Project => ({
    ...project,
    agents: project.agents.map((a) => (a.name === agentName ? { ...a, enabled } : a)),
  })

  const offSave = store.save(setAgentEnabled(false))
  if (offSave instanceof Error) return c.text(`leuco: ${offSave.message}`, 500)
  c.var.daemon.reload()

  await sleepReconcileGap()

  const onSave = store.save(setAgentEnabled(true))
  if (onSave instanceof Error) return c.text(`leuco: ${onSave.message}`, 500)
  const reload = c.var.daemon.reload()

  const tail = wasEnabled ? "" : " (was disabled; ended up enabled)"
  const reloadMsg = reload.signalled ? "(daemon reloaded)" : "(daemon not running)"
  return c.text(`restarted agent ${projectName}/${agentName}${tail} ${reloadMsg}`)
})
