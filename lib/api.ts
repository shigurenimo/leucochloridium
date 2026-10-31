import pkg from "../package.json" with { type: "json" }

if (!Bun.semver.satisfies(Bun.version, pkg.engines.bun))
  throw new Error(
    `Bun ${pkg.engines.bun} is required; found ${Bun.version}. Upgrade Bun before importing Leuco.`,
  )

export { LeucoRuntime } from "@/runtime/runtime"
export type { LeucoRuntimeProps } from "@/runtime/runtime"
export type { SlackCommandOptions } from "@/runtime/slack-command-options"
export type { LeucoSettings, LeucoState, ScheduleEntry } from "@/config/config-schema"
