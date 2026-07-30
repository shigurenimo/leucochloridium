#!/usr/bin/env bun
import { join } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { app } from "@/cli/routes"
import { help as rootHelp } from "@/cli/routes/group.help"
import { applyCwdShortcut } from "@/cli/utils/apply-cwd-shortcut"
import { parseCliInvocation } from "@/cli/utils/parse-cli-invocation"
import { LeucoDaemon } from "@/daemon/leuco-daemon"
import { LeucoEnv } from "@/env/leuco-env"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

process.title = "leuco"

const cwd = process.cwd()

const env = new LeucoEnv({ env: process.env })

const args = process.argv.slice(2)

// Load cwd .env files ONLY for the foreground `leuco run`. Every other
// command spawns or signals the long-lived daemon with `process.env`, and an
// unconditional load would bake whatever directory the user happened to run
// `leuco start` from — including unrelated secrets — into the daemon and
// every project runtime's codex child.
const skippedEnvFile = { path: "", loaded: false, keys: [] as string[] }
const envFiles =
  args[0] === "run"
    ? {
        local: env.loadFile(join(cwd, ".env.local")),
        base: env.loadFile(join(cwd, ".env")),
      }
    : { local: skippedEnvFile, base: skippedEnvFile }

if (args[0] === "--version" || args[0] === "-v") {
  process.stdout.write(`${pkg.version}\n`)
  process.exit(0)
}

const binPath = process.argv[1]

if (!binPath) {
  process.stderr.write("leuco: cannot determine own bin path\n")
  process.exit(1)
}

const paths = new LeucoPaths()
const daemon = new LeucoDaemon({ paths })
const projectStore = new LeucoProjectStore({ paths })
const projectIdScope = process.env.LEUCO_PROJECT_ID ?? null
const scopedProject =
  projectIdScope === null
    ? null
    : (() => {
        try {
          return projectStore.load(projectIdScope)
        } catch {
          process.stderr.write(`leuco: scoped project not found: ${projectIdScope}\n`)
          process.exit(1)
        }
      })()

// A project runtime Codex child always expands the shorter `leuco connectors …` form to
// its injected project scope. Operator shells use a registered cwd match.
const argsAfterShortcut = applyCwdShortcut({
  args,
  cwd,
  projectStore,
  scopedProject,
})

const invocation = parseCliInvocation(argsAfterShortcut)

// Top-level `--help` / `-h` on the bare `leuco` invocation prints the rooted
// HELP text rather than invoking the start handler's help.
if (invocation.path === "/" && invocation.parsed.flags.help) {
  process.stdout.write(`${rootHelp}\n`)
  process.exit(0)
}

const res = await app.dispatch({
  path: invocation.path,
  body: invocation.body,
  variables: {
    daemon,
    cwd,
    projectIdScope,
    binPath,
    envFiles,
    version: pkg.version,
  },
})

if (res.ok === false) {
  const text = await res.text()
  if (text) {
    process.stderr.write(`${text}\n`)
  }
  process.exit(1)
}

const text = await res.text()

if (text) {
  process.stdout.write(`${text}\n`)
}

// Routes whose body must stay pipeable on stdout even when they signal
// failure (status / doctor) return 200 plus this header instead of a 5xx.
const cliExit = res.headers.get("x-cli-exit")
if (cliExit !== null && cliExit !== "0") {
  process.exit(Number.parseInt(cliExit, 10) || 1)
}
