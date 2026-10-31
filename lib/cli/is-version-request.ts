import { CliError } from "@/cli/cli-error"
import { parseArguments } from "@/cli/parse-arguments"

/** Version mode bypasses execution, but retains the normal flag contract. */
export function isVersionRequest(args: readonly string[]): boolean {
  const versions = args.filter((arg) => arg === "--version" || arg === "-v")
  if (
    versions.length === 0 ||
    !args.every((arg) => ["--version", "-v", "--json", "--yaml"].includes(arg))
  )
    return false
  if (versions.length > 1) throw new CliError("USAGE", "Duplicate flag: --version / -v")
  parseArguments(args.filter((arg) => arg !== "--version" && arg !== "-v"))
  return true
}
