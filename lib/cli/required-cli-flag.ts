import type { CliArguments } from "@/cli/parse-arguments"

export function requiredCliFlag(parsed: CliArguments, name: string): string {
  const value = parsed.flags[name]
  if (typeof value !== "string") throw new Error(`--${name} is required`)
  return value
}
