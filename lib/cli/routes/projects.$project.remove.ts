import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"
import { daemonSupervisionWarning, startDaemon } from "@/daemon/daemon-control"
import { LeucoProjectStore } from "@/projects/project-store"
import { removeProjectSafely } from "@/projects/remove-project-safely"

const help = `leuco projects <p> remove / unregister a project

usage / leuco projects <p> remove [--cascade] [--force]

options:
  --cascade / also remove the project's channels from config
  --force / allow removing the project from inside its own Codex session

The registered project directory itself is not touched.
~/.leuco/projects/<id>/ (including the tenant's CODEX_HOME) is deleted.`

export const projectsRemoveHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const name = c.req.param("project")!

  const store = new LeucoProjectStore()
  const project = resolveProject(store, name, { preferCwd: c.var.cwd })

  // Removing a project deletes its CODEX_HOME — an agent doing this to its
  // own project would erase its memory out from under the running codex.
  if (!flagBool(body.flags.force) && isCurrentCodexProject(project)) {
    throw new HTTPException(400, { message: selfProjectGuardMessage(name, "remove") })
  }

  const cascade = flagBool(body.flags.cascade)
  if (project.channels.length > 0 && !cascade) {
    throw new HTTPException(400, {
      message: `project '${name}' has ${project.channels.length} channel(s). use --cascade to remove with its channels.`,
    })
  }

  // Persist the desired stop even when the project was already disabled: a
  // missed earlier reload can leave a stale tenant alive. Then terminate the
  // daemon and wait for Engine.stop() to drain every tenant before rmSync
  // removes this project's CODEX_HOME.
  const removed = await removeProjectSafely({
    project,
    store,
    daemon: c.var.daemon,
    restart: () =>
      startDaemon({
        daemon: c.var.daemon,
        binPath: c.var.binPath,
        env: process.env,
      }),
  })
  if (removed instanceof Error) {
    throw new HTTPException(500, {
      message: `project removal failed: ${removed.message}`,
    })
  }

  if (!removed.daemonWasRunning || removed.restarted === null) {
    return c.text(`removed project "${name}" (daemon not running)`)
  }

  const reloadMsg =
    removed.restarted.mode === "launchd"
      ? `(daemon restarted via launchd, ${removed.restarted.label})`
      : `(daemon restarted, pid ${removed.restarted.pid})`
  const lines = [`removed project "${name}" ${reloadMsg}`]
  const warning = daemonSupervisionWarning(removed.restarted)
  if (warning !== null) lines.push(warning)
  return c.text(lines.join("\n"))
})
