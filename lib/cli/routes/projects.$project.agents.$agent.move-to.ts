import { HTTPException } from "hono/http-exception"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { dirname } from "node:path"
import { factory } from "@/cli/cli-factory"
import { findAgent, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> agents <a> move-to — move an agent to another project

usage: leuco projects <p> agents <a> move-to <dst-project>

  <dst-project>   target project name (must already be registered)

Moves the agent — with all its channels, tokens, schedules, and memories — out
of <p> and into <dst-project>:
  - settings.json: removes from <p>, appends to <dst-project> (name unchanged)
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

  const agent = findAgent(src, agentName)

  const dst = resolveProject(store, dstName)

  if (src.id === dst.id) {
    throw new HTTPException(400, {
      message: `source and destination are the same project (${srcName})`,
    })
  }
  if (dst.agents.some((a) => a.name === agentName)) {
    throw new HTTPException(400, { message: `agent already exists in ${dstName}: ${agentName}` })
  }

  // Stop the daemon before touching CODEX_HOME so the running codex child does
  // not race the rename. Restart after the move if it was running.
  const daemon = c.var.daemon
  const wasRunning = daemon.status().isRunning
  if (wasRunning) {
    daemon.stop()
  }

  // 1. Move codex-home so memories travel with the agent.
  const oldHome = paths.agentDir(src.id, agentName)
  const newHome = paths.agentDir(dst.id, agentName)
  if (existsSync(oldHome)) {
    if (existsSync(newHome)) {
      throw new HTTPException(500, { message: `target codex-home already exists: ${newHome}` })
    }
    const parent = dirname(newHome)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    renameSync(oldHome, newHome)
  }

  // 2. Update settings.json on both sides.
  store.save({
    ...src,
    agents: src.agents.filter((a) => a.name !== agentName),
  })

  store.save({
    ...dst,
    agents: [...dst.agents, agent],
  })

  const lines = [`moved agent ${srcName}/${agentName} → ${dstName}/${agentName}`]
  if (wasRunning) {
    const result = daemon.start({ binPath: c.var.binPath, env: process.env })
    lines.push(`daemon restarted (pid ${result.pid})`)
  }
  return c.text(lines.join("\n"))
})
