import { resolve } from "node:path"
import type { CliArguments } from "@/cli/parse-arguments"
import type { LaunchConfiguration } from "@/maintenance/maintenance-schema"
export function launchOverrides(parsed: CliArguments): Pick<LaunchConfiguration, "cwd" | "soul"> {
  const overrides: Pick<LaunchConfiguration, "cwd" | "soul"> = {}
  if (typeof parsed.flags.cwd === "string") overrides.cwd = resolve(parsed.flags.cwd)
  if (typeof parsed.flags.soul === "string") overrides.soul = resolve(parsed.flags.soul)
  if (parsed.flags["no-soul"]) overrides.soul = null
  return overrides
}
