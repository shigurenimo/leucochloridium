import { isVersionRequest } from "@/cli/is-version-request"
import { parseArguments } from "@/cli/parse-arguments"
import type { CliArguments } from "@/cli/parse-arguments"
import { validateCommand } from "@/cli/validate-command"

export type CliInvocation =
  | { mode: "version" }
  | { mode: "help"; parsed: CliArguments }
  | { mode: "command"; parsed: CliArguments }

export function parseCliInvocation(args: readonly string[]): CliInvocation {
  if (isVersionRequest(args)) return { mode: "version" }
  const parsed = parseArguments(args)
  if (parsed.flags.help || args.length === 0) return { mode: "help", parsed }
  validateCommand(parsed)
  return { mode: "command", parsed }
}
