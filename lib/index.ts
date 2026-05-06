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
import { startMcpServer } from "@/mcp/start-mcp-server"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

process.title = "leuco"

const cwd = process.cwd()

const env = new LeucoEnv({ env: process.env })

const envFiles = {
  local: env.loadFile(join(cwd, ".env.local")),
  base: env.loadFile(join(cwd, ".env")),
}

const args = process.argv.slice(2)

if (args[0] === "--version" || args[0] === "-v") {
  process.stdout.write(`${pkg.version}\n`)
  process.exit(0)
}

// stdio MCP entry. Spawned by codex via `[mcp_servers.leuco]` in each tenant's
// CODEX_HOME config.toml; takes the (project, agent) pair from flags so the
// server is locked to that tenant's Slack tokens.
if (args[0] === "mcp") {
  const flag = (name: string): string | null => {
    const idx = args.indexOf(`--${name}`)
    if (idx < 0) return null
    const value = args[idx + 1]
    return typeof value === "string" ? value : null
  }
  const projectName = flag("project")
  const agentName = flag("agent")
  if (!projectName || !agentName) {
    process.stderr.write("usage: leuco mcp --project <name> --agent <name>\n")
    process.exit(2)
  }
  await startMcpServer({ projectName, agentName })
  // server keeps the process alive via stdio
  await new Promise<void>(() => {})
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
// `leuco agents …` / `leuco channels …` form by injecting the project name
// before parsing.
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
