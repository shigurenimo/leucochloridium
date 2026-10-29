import { COMMANDS, DEFAULT_COMMANDS } from "@/cli/command-catalog"
import { CliError } from "@/cli/cli-error"

export function resolveCommand(words: string[]) {
  const first = words[0] ?? ""
  const alias = words.length === 1 ? DEFAULT_COMMANDS[first] : undefined
  const definition =
    COMMANDS.find((entry) => entry.name === (alias ?? words.slice(0, 2).join(" "))) ??
    COMMANDS.find((entry) => entry.name === first)
  if (definition === undefined)
    throw new CliError(
      "USAGE",
      "Unknown command. Run leuco --help --json to discover supported commands.",
    )
  return { definition, arguments: alias ? [] : words.slice(definition.name.split(" ").length) }
}
