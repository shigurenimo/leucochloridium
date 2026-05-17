import { factory } from "@/cli/cli-factory"
import { findAgent, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { sleepReconcileGap } from "@/cli/utils/reconcile-gap"
import type { Project } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> reset — drop the agent's codex thread id

usage: leuco projects <p> agents <a> reset

Clears \`codexThreadId\` in settings.json so the next turn starts a fresh
codex thread. Codex memories under <CODEX_HOME>/memory/ are kept; only the
conversation history pointer is dropped.

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
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  const previousThreadId = agent.codexThreadId ?? null
  const cleared = store.setAgentThreadId(project.id, agentName, null)
  if (cleared instanceof Error) return c.text(`leuco: ${cleared.message}`, 500)

  if (!agent.enabled) {
    const tail = previousThreadId === null ? " (was already empty)" : ` (was ${previousThreadId})`
    return c.text(
      `reset thread for ${projectName}/${agentName}${tail} (agent disabled; takes effect on enable)`,
    )
  }

  const reloaded = store.load(project.id)
  if (reloaded instanceof Error) return c.text(`leuco: ${reloaded.message}`, 500)

  const setEnabled = (enabled: boolean): Project => ({
    ...reloaded,
    agents: reloaded.agents.map((a) => (a.name === agentName ? { ...a, enabled } : a)),
  })

  const offSave = store.save(setEnabled(false))
  if (offSave instanceof Error) return c.text(`leuco: ${offSave.message}`, 500)
  c.var.daemon.reload()

  await sleepReconcileGap()

  const onSave = store.save(setEnabled(true))
  if (onSave instanceof Error) return c.text(`leuco: ${onSave.message}`, 500)
  const reload = c.var.daemon.reload()

  const reloadMsg = reload.signalled ? "(daemon reloaded)" : "(daemon not running)"
  const previousMsg = previousThreadId === null ? "" : ` previous=${previousThreadId}`

  return c.text(`reset thread for ${projectName}/${agentName}${previousMsg} ${reloadMsg}`)
})
