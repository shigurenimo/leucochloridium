import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> remove / unregister a project

usage / leuco projects <p> remove [--cascade] [--force]

options:
  --cascade / also remove the project's channels from config
  --force / allow removing the project from inside its own Codex session

The project directory itself is not touched, and .codex/agents/*.toml files
inside the repository are left in place. ~/.leuco/projects/<id>/ (including
the tenant's CODEX_HOME) is deleted.`

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
      message: `leuco: project '${name}' has ${project.channels.length} channel(s). use --cascade to remove with its channels.`,
    })
  }

  store.remove(project.id)
  return c.text(`removed project "${name}"`)
})
