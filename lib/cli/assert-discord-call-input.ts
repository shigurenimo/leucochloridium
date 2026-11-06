import { CliError } from "@/cli/cli-error"
import type { CliArguments } from "@/cli/parse-arguments"

/** Mirrors the daemon's discordCall checks beyond the catalog pattern so they fail as USAGE before dispatch. */
export function assertDiscordCallInput(
  method: string,
  endpoint: string,
  flags: CliArguments["flags"],
): void {
  if (method === "GET" && flags.body !== undefined)
    throw new CliError("USAGE", "GET requests use query parameters in the endpoint, not --body", {
      parameter: "body",
    })
  const decoded = decodeEndpointPath(endpoint.split("?")[0] ?? "")
  if (decoded === null)
    throw new CliError("USAGE", "Discord endpoint path has invalid percent-encoding", {
      parameter: "endpoint",
    })
  if (decoded.includes("\\") || decoded.split("/").some((part) => part === "." || part === ".."))
    throw new CliError("USAGE", "Discord endpoint traversal is not allowed", {
      parameter: "endpoint",
    })
}

function decodeEndpointPath(path: string): string | null {
  try {
    return decodeURIComponent(path)
  } catch {
    return null
  }
}
