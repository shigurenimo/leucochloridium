const SHORT_FLAGS: Record<string, string> = {
  h: "help",
  f: "follow",
  v: "version",
}

const TOP_LEAFS = new Set(["run", "start", "stop", "restart", "status", "logs", "tui", "update"])
const PROJECT_LEAFS = new Set(["list", "create", "add"])
const AGENT_LEAFS = new Set(["list", "add"])
const CHANNEL_LEAFS = new Set(["list", "add"])
const NAMED_LEAFS = new Set([
  "remove",
  "show",
  "rename",
  "start",
  "stop",
  "restart",
  "reset",
  "set-tokens",
])
const SCHEDULE_LEAFS = new Set(["add", "list", "remove"])
const SLACK_LEAFS = new Set(["call"])
const CONFIG_LEAFS = new Set(["list", "get", "set"])
const BOOT_LEAFS = new Set(["install", "uninstall", "status"])

type Stage =
  | "top"
  | "projects"
  | "named-project"
  | "agents"
  | "named-agent"
  | "channels"
  | "named-channel"
  | "schedules"
  | "slack"
  | "config"
  | "boot"
  | "done"

export type CliRequestBody = {
  args: string[]
  flags: Record<string, string | boolean>
}

export type CliRequest = {
  method: "POST"
  path: string
  url: string
  body: string
  parsed: CliRequestBody
}

/**
 * Convert leuco CLI argv into a synthetic POST request the hono app can route.
 *
 * The grammar is nested:
 *   leuco <top-leaf>                                          → /<leaf>
 *   leuco projects <project-leaf>                             → /projects/<leaf>
 *   leuco projects <name> <named-leaf>                        → /projects/<name>/<leaf>
 *   leuco projects <name> agents <agent-leaf>                 → /projects/<name>/agents/<leaf>
 *   leuco projects <name> agents <name> <named-leaf>          → /projects/<name>/agents/<name>/<leaf>
 *   leuco projects <name> agents <name> channels <chan-leaf>  → /projects/<name>/agents/<name>/channels/<leaf>
 *   leuco projects <name> agents <name> channels <name> <named-leaf>
 *
 * `top-leafs`: run | start | stop | restart | status | logs | tui | update
 * `project-leafs` / `agent-leafs` / `channel-leafs`: list | create | add
 * `config-leafs`: list | get | set
 * `boot-leafs`: install | uninstall | status
 * `named-leafs` (after a name): remove | show | rename | start | stop | restart | reset | set-tokens
 *
 * Anything past the recognised leaf becomes positional `args`. `--key value`
 * and bare `--flag` populate `flags`; single-letter `-x` expands via SHORT_FLAGS.
 */
export const toRequest = (args: string[]): CliRequest => {
  const segments: string[] = []
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  let stage: Stage = "top"
  let i = 0

  while (i < args.length) {
    const arg = args[i]!

    if (arg.startsWith("--")) {
      const key = arg.slice(2)
      const next = args[i + 1]

      if (typeof next === "string" && !next.startsWith("-")) {
        flags[key] = next
        i += 2
      } else {
        flags[key] = true
        i++
      }

      continue
    }

    if (arg.startsWith("-") && arg.length === 2) {
      const long = SHORT_FLAGS[arg[1]!]
      if (long) flags[long] = true
      i++
      continue
    }

    if (stage === "done") {
      positional.push(arg)
      i++
      continue
    }

    const decision = step(stage, arg)

    if (decision.kind === "segment") {
      segments.push(arg)
      stage = decision.next
    } else {
      positional.push(arg)
      stage = "done"
    }

    i++
  }

  const path = segments.length > 0 ? `/${segments.join("/")}` : "/"
  const parsed: CliRequestBody = { args: positional, flags }

  return {
    method: "POST",
    path,
    url: `http://localhost${path}`,
    body: JSON.stringify(parsed),
    parsed,
  }
}

type StepDecision = { kind: "segment"; next: Stage } | { kind: "positional" }

const step = (stage: Stage, arg: string): StepDecision => {
  if (stage === "top") {
    if (TOP_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    if (arg === "projects") return { kind: "segment", next: "projects" }
    if (arg === "slack") return { kind: "segment", next: "slack" }
    if (arg === "config") return { kind: "segment", next: "config" }
    if (arg === "boot") return { kind: "segment", next: "boot" }
    return { kind: "segment", next: "done" }
  }

  if (stage === "boot") {
    if (BOOT_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    return { kind: "positional" }
  }

  if (stage === "slack") {
    if (SLACK_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    return { kind: "positional" }
  }

  if (stage === "config") {
    if (CONFIG_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    return { kind: "positional" }
  }

  if (stage === "projects") {
    if (PROJECT_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    return { kind: "segment", next: "named-project" }
  }

  if (stage === "named-project") {
    if (NAMED_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    if (arg === "agents") return { kind: "segment", next: "agents" }
    return { kind: "positional" }
  }

  if (stage === "agents") {
    if (AGENT_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    return { kind: "segment", next: "named-agent" }
  }

  if (stage === "named-agent") {
    if (NAMED_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    if (arg === "channels") return { kind: "segment", next: "channels" }
    return { kind: "positional" }
  }

  if (stage === "channels") {
    if (CHANNEL_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    return { kind: "segment", next: "named-channel" }
  }

  if (stage === "named-channel") {
    if (NAMED_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    if (arg === "schedules") return { kind: "segment", next: "schedules" }
    return { kind: "positional" }
  }

  if (stage === "schedules") {
    if (SCHEDULE_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    return { kind: "positional" }
  }

  return { kind: "positional" }
}
