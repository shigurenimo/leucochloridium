const SHORT_FLAGS: Record<string, string> = {
  h: "help",
  f: "follow",
  v: "version",
}

/**
 * Flags that never take a value. A bare value-taking flag greedily consumes
 * the next non-flag token, so `--force restart` would otherwise swallow the
 * `restart` leaf (flags.force="restart" → flagBool false, command unrouted).
 */
const BOOLEAN_FLAGS = new Set([
  "help",
  "force",
  "follow",
  "version",
  "json",
  "fix",
  "cascade",
  "check",
])

const TOP_LEAFS = new Set([
  "run",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "events",
  "update",
  "doctor",
  "kill",
])
const PROJECT_LEAFS = new Set(["list", "create", "add"])
const CHANNEL_LEAFS = new Set(["list", "add"])
const PROJECT_NAMED_LEAFS = new Set([
  "remove",
  "rename",
  "relocate",
  "start",
  "stop",
  "restart",
  "reset",
  "path",
])
const CHANNEL_NAMED_LEAFS = new Set([
  "remove",
  "rename",
  "start",
  "stop",
  "restart",
  "set-tokens",
  "download-file",
])
const PROJECT_SESSION_LEAFS = new Set(["reset"])
const SCHEDULE_LEAFS = new Set(["add", "list", "remove"])
const SLACK_LEAFS = new Set(["call"])
const CONFIG_LEAFS = new Set(["list", "get", "set"])
const BOOT_LEAFS = new Set(["install", "uninstall", "status"])

type Stage =
  | "top"
  | "projects"
  | "named-project"
  | "project-session"
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
 *   leuco projects <name> channels <chan-leaf>                 → /projects/<name>/channels/<leaf>
 *   leuco projects <name> channels <name> <named-leaf>        → /projects/<name>/channels/<name>/<leaf>
 *   leuco projects <name> channels <name> schedules <leaf>    → /projects/<name>/channels/<name>/schedules/<leaf>
 *
 * `top-leafs`: run | start | stop | restart | status | logs | events | update | doctor | kill
 * `project-leafs`: list | create | add
 * `channel-leafs`: list | add
 * `config-leafs`: list | get | set
 * `boot-leafs`: install | uninstall | status
 * project `named-leafs`: remove | rename | relocate | start | stop | restart | reset | path
 * channel `named-leafs`: remove | rename | start | stop | restart | set-tokens | download-file
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
      const body = arg.slice(2)
      const eqIndex = body.indexOf("=")
      if (eqIndex !== -1) {
        flags[body.slice(0, eqIndex)] = body.slice(eqIndex + 1)
        i++
        continue
      }

      const key = body
      const next = args[i + 1]

      if (!BOOLEAN_FLAGS.has(key) && typeof next === "string" && !isFlagToken(next)) {
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
    if (PROJECT_NAMED_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    if (arg === "session") return { kind: "segment", next: "project-session" }
    if (arg === "channels") return { kind: "segment", next: "channels" }
    return { kind: "positional" }
  }

  if (stage === "project-session") {
    if (PROJECT_SESSION_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    return { kind: "positional" }
  }

  if (stage === "channels") {
    if (CHANNEL_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    return { kind: "segment", next: "named-channel" }
  }

  if (stage === "named-channel") {
    if (CHANNEL_NAMED_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    if (arg === "schedules") return { kind: "segment", next: "schedules" }
    return { kind: "positional" }
  }

  if (stage === "schedules") {
    if (SCHEDULE_LEAFS.has(arg)) return { kind: "segment", next: "done" }
    return { kind: "positional" }
  }

  return { kind: "positional" }
}

const isFlagToken = (token: string): boolean => {
  if (!token.startsWith("-")) return false
  if (token.length === 1) return false
  const tail = token.slice(1)
  if (tail.startsWith("-")) return true
  return Number.isNaN(Number(token))
}
