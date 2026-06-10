import { HTTPException } from "hono/http-exception"
import { join } from "node:path"
import { factory } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco path / print leuco filesystem paths

usage / leuco path [key] [--project <p>]

keys:
  (none), root, home / ~/.leuco
  settings / ~/.leuco/settings.json
  daemon / ~/.leuco/daemon
  log / daemon log
  events, events-db / daemon events database
  projects / ~/.leuco/projects
  codex-auth / ~/.codex/auth.json
  project / project runtime directory (requires --project)
  codex, project-home / project CODEX_HOME (requires --project)
  agents / project AGENTS.md path (requires --project)

examples:
  leuco path
  leuco path log
  leuco path codex --project azamino
  leuco path agents --project azamino`

export const pathHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const key = body.args[0] ?? "root"
  const paths = new LeucoPaths()

  const path =
    key === "root" || key === "home"
      ? paths.root()
      : key === "settings"
        ? paths.settingsPath()
        : key === "daemon"
          ? paths.daemonDir()
          : key === "log"
            ? paths.daemonLogPath()
            : key === "events" || key === "events-db"
              ? paths.daemonEventLogPath()
              : key === "projects"
                ? paths.projectsRoot()
                : key === "codex-auth"
                  ? paths.codexAuthPath()
                  : projectPath(key, paths, body.flags.project, c.var.cwd)

  return c.text(`${path}\n`)
})

const projectPath = (
  key: string,
  paths: LeucoPaths,
  projectFlag: string | boolean | undefined,
  cwd: string,
): string => {
  if (key !== "project" && key !== "codex" && key !== "project-home" && key !== "agents") {
    throw new HTTPException(400, { message: `unknown path key: ${key}` })
  }

  const projectName = flagString(projectFlag)
  if (!projectName) {
    throw new HTTPException(400, { message: `${key} path requires --project <p>` })
  }

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: cwd })

  if (key === "project") return paths.projectDir(project.id)

  const codexHome = paths.projectHome(project.id)
  if (key === "agents") return join(codexHome, "AGENTS.md")
  return codexHome
}
