import { HTTPException } from "hono/http-exception"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { dirname } from "node:path"
import { factory } from "@/cli/cli-factory"
import { findAgent, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"
import { errorMessage } from "@/error-message"
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
    throw new HTTPException(400, {
      message: `usage: leuco projects ${srcName} agents ${agentName} move-to <dst-project>`,
    })
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

  // Track per-step success so the catch can reverse each completed step in
  // order. Without this, a failure on step 3 leaves codex-home / TOML moved
  // but settings.json out of sync, and the agent's codex thread is lost.
  let tomlMoved = false
  let homeMoved = false
  let dstSaved = false
  const oldHome = paths.agentDir(src.id, agentName)
  const newHome = paths.agentDir(dst.id, agentName)

  try {
    // 1. Move the codex TOML between repo `.codex/agents/` dirs. Skipped when
    // both projects point at the same repo path — the file is already where
    // codex expects it. A missing src toml is recorded but non-fatal so a
    // partially-cleaned source can still be migrated.
    let tomlMessage = "(toml unchanged)"
    if (src.path !== dst.path) {
      tomlMessage = moveCodexToml({ srcPath: src.path, dstPath: dst.path, agentName })
      tomlMoved = !tomlMessage.startsWith("(src toml missing")
    }

    // 2. Move codex-home so memories travel with the agent.
    if (existsSync(oldHome)) {
      if (existsSync(newHome)) {
        throw new HTTPException(500, { message: `target codex-home already exists: ${newHome}` })
      }
      const parent = dirname(newHome)
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
      renameSync(oldHome, newHome)
      homeMoved = true
    }

    // 3. Update settings.json on both sides. Write dst first so a failure on
    // the src write leaves the agent registered under both projects rather
    // than vanishing entirely.
    store.save({
      ...dst,
      agents: [...dst.agents, agent],
    })
    dstSaved = true

    store.save({
      ...src,
      agents: src.agents.filter((a) => a.name !== agentName),
    })

    const lines = [`moved agent ${srcName}/${agentName} → ${dstName}/${agentName} ${tomlMessage}`]
    if (wasRunning) {
      const result = daemon.start({ binPath: c.var.binPath, env: process.env })
      lines.push(`daemon restarted (pid ${result.pid})`)
    }
    return c.text(lines.join("\n"))
  } catch (error) {
    if (dstSaved) {
      try {
        store.save(dst)
      } catch (rollbackError) {
        process.stderr.write(
          `[leuco] move-to rollback: dst settings stranded: ${errorMessage(rollbackError)}\n`,
        )
      }
    }
    if (homeMoved) {
      try {
        renameSync(newHome, oldHome)
      } catch (rollbackError) {
        process.stderr.write(
          `[leuco] move-to rollback: codex-home stranded at ${newHome}: ${errorMessage(rollbackError)}\n`,
        )
      }
    }
    if (tomlMoved) {
      try {
        moveCodexToml({ srcPath: dst.path, dstPath: src.path, agentName })
      } catch (rollbackError) {
        process.stderr.write(
          `[leuco] move-to rollback: toml stranded in ${dst.path}: ${errorMessage(rollbackError)}\n`,
        )
      }
    }
    if (wasRunning && !daemon.status().isRunning) {
      daemon.start({ binPath: c.var.binPath, env: process.env })
    }
    throw error
  }
})

// Move `.codex/agents/<a>.toml` from src to dst, returning a status string
// for the CLI. A missing src toml is non-fatal so a partially-cleaned
// source can still be migrated; any other read failure (malformed TOML,
// EACCES, EIO) is propagated so the user knows the spec was NOT moved.
const moveCodexToml = (props: { srcPath: string; dstPath: string; agentName: string }): string => {
  const srcToml = new LeucoCodexAgentStore({ cwd: props.srcPath })
  let spec
  try {
    spec = srcToml.read({ scope: "project", name: props.agentName })
  } catch (error) {
    const message = errorMessage(error)
    if (message.startsWith("agent not found:")) {
      return `(src toml missing: ${message})`
    }
    throw error
  }

  const dstToml = new LeucoCodexAgentStore({ cwd: props.dstPath })
  const added = dstToml.add({
    scope: "project",
    name: props.agentName,
    description: spec.description,
    developerInstructions: spec.developerInstructions,
    model: spec.model,
  })

  srcToml.remove("project", props.agentName)

  return `(toml: ${added})`
}
