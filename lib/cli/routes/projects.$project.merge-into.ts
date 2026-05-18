import { existsSync, mkdirSync, renameSync } from "node:fs"
import { dirname } from "node:path"
import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <src> merge-into <dst> — move every agent and unregister <src>

usage: leuco projects <src> merge-into <dst>

  <dst>   target project name (must already be registered)

Bulk equivalent of running \`leuco projects <src> agents <a> move-to <dst>\`
for every agent in <src>, followed by \`leuco projects <src> remove\`. On
success the source project no longer exists; the destination owns all
agents, channels, schedule entries, and memories that lived under <src>.

Refuses to start when any agent name collides between the two projects —
rename in <src> first. The daemon is stopped once at the beginning and
restarted at the end (when originally running) so codex children pick
up the new tenant set.`

export const projectsMergeIntoHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const srcName = c.req.param("project")!
  const dstName = body.args[0]
  if (!dstName) {
    throw new HTTPException(400, {
      message: `usage: leuco projects ${srcName} merge-into <dst>`,
    })
  }

  const paths = new LeucoPaths()
  const store = new LeucoProjectStore({ paths })

  const src = resolveProject(store, srcName, { preferCwd: c.var.cwd })
  const dst = resolveProject(store, dstName)

  if (src.id === dst.id) {
    throw new HTTPException(400, {
      message: `source and destination are the same project (${srcName})`,
    })
  }

  const dstAgentNames = new Set(dst.agents.map((a) => a.name))
  const conflicts = src.agents.filter((a) => dstAgentNames.has(a.name))
  if (conflicts.length > 0) {
    throw new HTTPException(400, {
      message: `agent name conflicts in ${dstName}: ${conflicts.map((a) => a.name).join(", ")}. rename them in ${srcName} first.`,
    })
  }

  const daemon = c.var.daemon
  const wasRunning = daemon.status().isRunning
  if (wasRunning) daemon.stop()

  const tomlMessages: string[] = []
  for (const agent of src.agents) {
    // Move the codex TOML between repo `.codex/agents/` dirs. Skipped when
    // both projects share the same repo path. Missing toml is non-fatal so
    // a partially-cleaned source can still be merged.
    if (src.path !== dst.path) {
      const srcToml = new LeucoCodexAgentStore({ cwd: src.path })
      try {
        const spec = srcToml.read({ scope: "project", name: agent.name })
        const dstToml = new LeucoCodexAgentStore({ cwd: dst.path })
        dstToml.add({
          scope: "project",
          name: agent.name,
          description: spec.description,
          developerInstructions: spec.developerInstructions,
          model: spec.model,
        })
        srcToml.remove("project", agent.name)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        tomlMessages.push(`${agent.name}: src toml missing (${message})`)
      }
    }

    // Move codex-home so memories / state.json travel with the agent.
    const oldHome = paths.agentDir(src.id, agent.name)
    const newHome = paths.agentDir(dst.id, agent.name)
    if (existsSync(oldHome)) {
      if (existsSync(newHome)) {
        throw new HTTPException(500, {
          message: `target codex-home already exists: ${newHome}`,
        })
      }
      const parent = dirname(newHome)
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
      renameSync(oldHome, newHome)
    }
  }

  // Append every src agent to dst, then drop src entirely. The directory
  // under ~/.leuco/projects/<src.id>/ is deleted; the repo at src.path
  // stays put — re-register it with `leuco projects add` if needed.
  store.save({ ...dst, agents: [...dst.agents, ...src.agents] })
  store.remove(src.id)

  const lines = [
    `merged ${srcName} → ${dstName} (${src.agents.length} agents): ${src.agents.map((a) => a.name).join(", ") || "(none)"}`,
  ]
  if (tomlMessages.length > 0) {
    for (const m of tomlMessages) lines.push(`  ${m}`)
  }
  if (wasRunning) {
    const result = daemon.start({ binPath: c.var.binPath, env: process.env })
    lines.push(`daemon restarted (pid ${result.pid})`)
  }
  return c.text(lines.join("\n"))
})
