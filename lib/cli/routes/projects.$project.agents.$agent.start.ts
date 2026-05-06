import { factory } from "@/cli/cli-factory"
import { findAgent } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> start — enable an agent (and reload daemon)

usage: leuco projects <p> agents <a> start

Sets the agent's \`enabled\` flag to true in settings.json. If the daemon is
running, sends SIGHUP so it reconciles tenants and spawns this agent's codex
+ channels immediately. If stopped, the change takes effect on next \`leuco
start\`.`

export const agentsStartHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!

  const store = new LeucoProjectStore()
  const project = store.load(projectName)
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  if (agent.enabled) {
    return c.text(`agent ${projectName}/${agentName} is already enabled`)
  }

  const saved = store.save({
    ...project,
    agents: project.agents.map((a) => (a.name === agentName ? { ...a, enabled: true } : a)),
  })
  if (saved instanceof Error) return c.text(`leuco: ${saved.message}`, 500)

  const reload = c.var.daemon.reload()
  const reloadMsg = reload.signalled
    ? `(daemon reloaded, pid ${reload.pid})`
    : "(daemon not running; takes effect on next `leuco start`)"

  return c.text(`enabled agent ${projectName}/${agentName} ${reloadMsg}`)
})
