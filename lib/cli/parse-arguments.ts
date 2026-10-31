import { COMMANDS, GLOBAL_OPTIONS } from "@/cli/command-catalog"
import { CliError } from "@/cli/cli-error"
export type CliArguments = { words: string[]; flags: Record<string, string | true> }

const PARAMETERS = [...GLOBAL_OPTIONS, ...COMMANDS.flatMap((command) => command.options)]
const BOOLEAN_FLAGS = new Set(
  PARAMETERS.filter((entry) => entry.type === "boolean").map((entry) => entry.name),
)
const VALUE_FLAGS = new Set(
  PARAMETERS.filter((entry) => entry.type !== "boolean").map((entry) => entry.name),
)

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
      if (parsed.flags.help) throw new CliError("USAGE", "Duplicate flag: --help")
      parsed.flags.help = true
      continue
    }
    if (!arg.startsWith("--")) {
      parsed.words.push(arg)
      continue
    }
    const equal = arg.indexOf("=")
    const name = arg.slice(2, equal < 0 ? undefined : equal)
    if (Object.hasOwn(parsed.flags, name)) throw new CliError("USAGE", `Duplicate flag: --${name}`)
    if (BOOLEAN_FLAGS.has(name)) {
      if (equal >= 0) throw new CliError("USAGE", `--${name} does not take a value`)
      parsed.flags[name] = true
      continue
    }
    if (!VALUE_FLAGS.has(name)) throw new CliError("USAGE", `Unknown flag: --${name}`)
    const value = equal >= 0 ? arg.slice(equal + 1) : args[cursor.index++]
    if (value === undefined || value.length === 0 || (equal < 0 && value.startsWith("--")))
      throw new CliError("USAGE", `--${name} requires a value`)
    parsed.flags[name] = value
  }
  if (parsed.flags.json && parsed.flags.yaml)
    throw new CliError("USAGE", "--json and --yaml cannot be combined")
  if (parsed.flags.soul !== undefined && parsed.flags["no-soul"])
    throw new CliError("USAGE", "--soul and --no-soul cannot be combined")
  return parsed
}
