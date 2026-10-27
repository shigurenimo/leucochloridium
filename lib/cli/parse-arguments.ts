export type CliArguments = { words: string[]; flags: Record<string, string | true> }

const BOOLEAN_FLAGS = new Set(["help", "no-soul"])
const VALUE_FLAGS = new Set([
  "cwd",
  "soul",
  "model",
  "codex-bin",
  "prompt",
  "thread",
  "name",
  "run-at",
  "body",
  "channel",
  "file",
  "thread-ts",
  "title",
  "comment",
  "out",
  "limit",
])

export function parseArguments(args: readonly string[]): CliArguments {
  const parsed: CliArguments = { words: [], flags: {} }
  const cursor = { index: 0 }
  while (cursor.index < args.length) {
    const arg = args[cursor.index++]!
    if (arg === "--") {
      parsed.words.push(...args.slice(cursor.index))
      break
    }
    if (arg === "-h") {
      parsed.flags.help = true
      continue
    }
    if (!arg.startsWith("--")) {
      parsed.words.push(arg)
      continue
    }
    const equal = arg.indexOf("=")
    const name = arg.slice(2, equal < 0 ? undefined : equal)
    if (name in parsed.flags) throw new Error(`Duplicate flag: --${name}`)
    if (BOOLEAN_FLAGS.has(name)) {
      if (equal >= 0) throw new Error(`--${name} does not take a value`)
      parsed.flags[name] = true
      continue
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown flag: --${name}`)
    const value = equal >= 0 ? arg.slice(equal + 1) : args[cursor.index++]
    if (value === undefined || value.length === 0 || value.startsWith("--"))
      throw new Error(`--${name} requires a value`)
    parsed.flags[name] = value
  }
  if (parsed.flags.soul !== undefined && parsed.flags["no-soul"])
    throw new Error("--soul and --no-soul cannot be combined")
  return parsed
}
