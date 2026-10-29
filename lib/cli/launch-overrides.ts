import { resolve } from "node:path"
import type { CliArguments } from "@/cli/parse-arguments"
import type { LaunchConfiguration } from "@/maintenance/maintenance-schema"
export function launchOverrides(parsed: CliArguments): Partial<LaunchConfiguration> {
  const overrides: Partial<LaunchConfiguration> = {}
  if (typeof parsed.flags.cwd === "string") overrides.cwd = resolve(parsed.flags.cwd)
  if (typeof parsed.flags.soul === "string") overrides.soul = resolve(parsed.flags.soul)
  if (parsed.flags["no-soul"]) overrides.soul = null
  if (typeof parsed.flags.model === "string") overrides.model = parsed.flags.model
  if (typeof parsed.flags["codex-bin"] === "string")
    overrides.codexBin = resolve(parsed.flags["codex-bin"])
  return overrides
}
