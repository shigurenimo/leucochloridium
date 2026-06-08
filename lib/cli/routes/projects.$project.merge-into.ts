import { existsSync, mkdirSync, renameSync } from "node:fs"
import { dirname } from "node:path"
import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"
import { errorMessage } from "@/error-message"
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
  // Collect rollback closures per-agent so a failure mid-loop can reverse
  // every completed step (each TOML moved + each codex-home renamed). Without
  // this, a throw at agent K leaves 0..K-1 physically moved while
  // settings.json still claims them on src, dropping their state.json on the
  // next daemon start.
  const undoSteps: Array<() => void> = []
  try {
    for (const agent of src.agents) {
      if (src.path !== dst.path) {
        const message = moveAgentToml({
          srcPath: src.path,
          dstPath: dst.path,
          agentName: agent.name,
        })
        if (message !== null) {
          tomlMessages.push(message)
        } else {
          // toml was actually moved (not missing) — register reverse move.
          const moved = agent.name
          undoSteps.push(() =>
            moveAgentToml({ srcPath: dst.path, dstPath: src.path, agentName: moved }),
          )
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
        undoSteps.push(() => renameSync(newHome, oldHome))
      }
    }

    // Append every src agent to dst, then drop src entirely. The directory
    // under ~/.leuco/projects/<src.id>/ is deleted; the repo at src.path
    // stays put — re-register it with `leuco projects add` if needed.
    store.save({ ...dst, agents: [...dst.agents, ...src.agents] })
    store.remove(src.id)
  } catch (error) {
    for (const undo of undoSteps.reverse()) {
      try {
        undo()
      } catch (rollbackError) {
        process.stderr.write(`[leuco] merge-into rollback failed: ${errorMessage(rollbackError)}\n`)
      }
    }
    if (wasRunning && !daemon.status().isRunning) {
      daemon.start({ binPath: c.var.binPath, env: process.env })
    }
    throw error
  }

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

// Move `.codex/agents/<a>.toml` from src to dst. Returns `null` when the move
// succeeded and a status line when the src toml was missing (non-fatal so a
// partially-cleaned source can still be merged).
const moveAgentToml = (props: {
  srcPath: string
  dstPath: string
  agentName: string
}): string | null => {
  const srcToml = new LeucoCodexAgentStore({ cwd: props.srcPath })
  let spec
  try {
    spec = srcToml.read({ scope: "project", name: props.agentName })
  } catch (error) {
    const message = errorMessage(error)
    // Only "not found" is treated as a soft skip — real FS / parse failures
    // are propagated so the merge does not silently drop a tenant's spec.
    if (message.startsWith("agent not found:")) {
      return `${props.agentName}: src toml missing (${message})`
    }
    throw error
  }

  const dstToml = new LeucoCodexAgentStore({ cwd: props.dstPath })
  dstToml.add({
    scope: "project",
    name: props.agentName,
    description: spec.description,
    developerInstructions: spec.developerInstructions,
    model: spec.model,
  })
  srcToml.remove("project", props.agentName)
  return null
}
