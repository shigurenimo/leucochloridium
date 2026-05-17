import { factory } from "@/cli/cli-factory"
import { findAgent, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { sleepReconcileGap } from "@/cli/utils/reconcile-gap"
import type { Project } from "@/config/config-schema"
import { LeucoAgentStateStore } from "@/projects/agent-state-store"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> reset — drop the agent's codex thread id

usage: leuco projects <p> agents <a> reset

Clears \`codexThreadId\` in agents/<a>/state.json so the next turn starts a
fresh codex thread. Codex memories under <CODEX_HOME>/memory/ are kept; only
the conversation history pointer is dropped.

If the agent is currently enabled, the tenant is restarted (off → SIGHUP →
on → SIGHUP, same dance as \`agents <a> restart\`) so the in-memory thread id
is also discarded.`

export const agentsResetHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  const agent = findAgent(project, agentName)

  const stateStore = new LeucoAgentStateStore({ paths: store.getPaths() })
  const previousThreadId = stateStore.load(project.id, agentName).codexThreadId
  stateStore.setCodexThreadId(project.id, agentName, null)

  if (!agent.enabled) {
    const tail = previousThreadId === null ? " (was already empty)" : ` (was ${previousThreadId})`
    return c.text(
      `reset thread for ${projectName}/${agentName}${tail} (agent disabled; takes effect on enable)`,
    )
  }

  const reloaded = store.load(project.id)

  const setEnabled = (enabled: boolean): Project => ({
    ...reloaded,
    agents: reloaded.agents.map((a) => (a.name === agentName ? { ...a, enabled } : a)),
  })

  store.save(setEnabled(false))
  c.var.daemon.reload()

  await sleepReconcileGap()

  store.save(setEnabled(true))
  const reload = c.var.daemon.reload()

  const reloadMsg = reload.signalled ? "(daemon reloaded)" : "(daemon not running)"
  const previousMsg = previousThreadId === null ? "" : ` previous=${previousThreadId}`

  return c.text(`reset thread for ${projectName}/${agentName}${previousMsg} ${reloadMsg}`)
})
