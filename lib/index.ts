#!/usr/bin/env bun
import { join } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { factory } from "@/cli/cli-factory"
import { app } from "@/cli/routes"
import { help as rootHelp } from "@/cli/routes/group.help"
import { applyCwdShortcut } from "@/cli/utils/apply-cwd-shortcut"
import { toRequest } from "@/cli/utils/to-request"
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
// every tenant's codex child.
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

// When the user is inside a registered project's cwd, allow the shorter
// `leuco channels …` form by injecting `projects <name>` before parsing.
const argsAfterShortcut = applyCwdShortcut(args, cwd, projectStore)

const cli = factory.createApp()

cli.use((c, next) => {
  c.set("daemon", daemon)
  c.set("cwd", cwd)
  c.set("binPath", binPath)
  c.set("envFiles", envFiles)
  c.set("version", pkg.version)
  return next()
})

cli.notFound((c) => {
  const cmd = c.req.path.replace(/^\//, "").replace(/\//g, " ")
  return c.text(`unknown command: ${cmd}\n\n${rootHelp}`, 404)
})

const dispatched = cli.route("/", app)

const request = toRequest(argsAfterShortcut)

const parsed = new URL(request.url)

// Top-level `--help` / `-h` on the bare `leuco` invocation prints the rooted
// HELP text rather than invoking the start handler's help.
if (parsed.pathname === "/" && request.parsed.flags.help) {
  process.stdout.write(`${rootHelp}\n`)
  process.exit(0)
}

const res = await dispatched.request(request.url, {
  method: request.method,
  body: request.body,
  headers: { "content-type": "application/json" },
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
