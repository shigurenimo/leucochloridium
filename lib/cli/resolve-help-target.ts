import { COMMANDS } from "@/cli/command-catalog"
import type { CommandDefinition } from "@/cli/command-catalog"
import { resolveCommand } from "@/cli/resolve-command"

/** No words or a group prefix lists commands; any other path resolves like execution. */
export function resolveHelpTarget(path: string[]): {
  command: CommandDefinition | null
  commands: CommandDefinition[]
} {
  if (path.length === 0) return { command: null, commands: COMMANDS }
  const group = COMMANDS.filter((entry) => entry.name.startsWith(`${path.join(" ")} `))
  if (group.length > 0) return { command: null, commands: group }
  const command = resolveCommand(path).definition
  return { command, commands: [command] }
}
