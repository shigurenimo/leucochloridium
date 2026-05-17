import { existsSync, mkdirSync, renameSync } from "node:fs"
import { dirname } from "node:path"
import { factory } from "@/cli/cli-factory"
import { findAgent, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> move-to — move an agent to another project

usage: leuco projects <p> agents <a> move-to <dst-project>

  <dst-project>   target project name (must already be registered)

Moves the agent — with all its channels, tokens, schedules, and memories — out
of <p> and into <dst-project>:
  - settings.json: removes from <p>, appends to <dst-project> (name unchanged)
  - <src-path>/.codex/agents/<a>.toml → <dst-path>/.codex/agents/<a>.toml
    (skipped when both projects share the same repo path)
  - ~/.leuco/projects/<src-id>/agents/<a>/ → ~/.leuco/projects/<dst-id>/agents/<a>/

The destination must not already contain an agent with the same name; rename
the agent in the source project first if it does.

The daemon is automatically stopped before the move and restarted after, so
the running codex child cannot hold stale CODEX_HOME / MCP URL state. If the
daemon was not running when invoked, it stays stopped after.`

export const agentsMoveToHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const srcName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const dstName = body.args[0]
  if (!dstName) {
    return c.text(`usage: leuco projects ${srcName} agents ${agentName} move-to <dst-project>`, 400)
  }

  const paths = new LeucoPaths()
  const store = new LeucoProjectStore({ paths })

  const src = resolveProject(store, srcName, { preferCwd: c.var.cwd })
  if (src instanceof Error) return c.text(`leuco: ${src.message}`, 404)

  const agent = findAgent(src, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  const dst = resolveProject(store, dstName)
  if (dst instanceof Error) return c.text(`leuco: ${dst.message}`, 404)

  if (src.id === dst.id) {
    return c.text(`leuco: source and destination are the same project (${srcName})`, 400)
  }
  if (dst.agents.some((a) => a.name === agentName)) {
    return c.text(`leuco: agent already exists in ${dstName}: ${agentName}`, 400)
  }

  // Stop the daemon before touching CODEX_HOME so the running codex child does
  // not race the rename. Restart after the move if it was running.
  const daemon = c.var.daemon
  const wasRunning = daemon.status().isRunning
  if (wasRunning) {
    daemon.stop()
  }

  // 1. Move the codex TOML between repo `.codex/agents/` dirs. Skipped when
  // both projects point at the same repo path — the file is already where
  // codex expects it. Missing toml is non-fatal so a partially-cleaned source
  // can still be migrated.
  let tomlMessage = "(toml unchanged)"
  if (src.path !== dst.path) {
    const srcToml = new LeucoCodexAgentStore({ cwd: src.path })
    const spec = srcToml.read({ scope: "project", name: agentName })
    if (spec instanceof Error) {
      tomlMessage = `(src toml missing: ${spec.message})`
    } else {
      const dstToml = new LeucoCodexAgentStore({ cwd: dst.path })
      const added = dstToml.add({
        scope: "project",
        name: agentName,
        description: spec.description,
        developerInstructions: spec.developerInstructions,
        model: spec.model,
      })
      if (added instanceof Error) return c.text(`leuco: ${added.message}`, 500)

      const removed = srcToml.remove("project", agentName)
      if (removed instanceof Error) return c.text(`leuco: ${removed.message}`, 500)

      tomlMessage = `(toml: ${added})`
    }
  }

  // 2. Move codex-home so memories travel with the agent.
  const oldHome = paths.agentDir(src.id, agentName)
  const newHome = paths.agentDir(dst.id, agentName)
  if (existsSync(oldHome)) {
    if (existsSync(newHome)) {
      return c.text(`leuco: target codex-home already exists: ${newHome}`, 500)
    }
    const parent = dirname(newHome)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    renameSync(oldHome, newHome)
  }

  // 3. Update settings.json on both sides.
  const removedSave = store.save({
    ...src,
    agents: src.agents.filter((a) => a.name !== agentName),
  })
  if (removedSave instanceof Error) return c.text(`leuco: ${removedSave.message}`, 500)

  const addedSave = store.save({
    ...dst,
    agents: [...dst.agents, agent],
  })
  if (addedSave instanceof Error) return c.text(`leuco: ${addedSave.message}`, 500)

  const lines = [`moved agent ${srcName}/${agentName} → ${dstName}/${agentName} ${tomlMessage}`]
  if (wasRunning) {
    const result = daemon.start({ binPath: c.var.binPath, env: process.env })
    if (result instanceof Error) {
      lines.push(`leuco: daemon restart failed: ${result.message}`)
      return c.text(lines.join("\n"), 500)
    }
    lines.push(`daemon restarted (pid ${result.pid})`)
  }
  return c.text(lines.join("\n"))
})
