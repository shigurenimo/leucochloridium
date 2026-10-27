import type { CliArguments } from "@/cli/parse-arguments"

const RUN_FLAGS = ["cwd", "soul", "no-soul", "model", "codex-bin"]
const COMMANDS: Record<string, { flags: string[]; min: number; max: number }> = {
  run: { flags: [...RUN_FLAGS, "prompt", "thread"], min: 1, max: 1 },
  start: { flags: RUN_FLAGS, min: 1, max: 1 },
  stop: { flags: [], min: 1, max: 1 },
  status: { flags: [], min: 1, max: 1 },
  ask: { flags: ["thread"], min: 2, max: Infinity },
  "config show": { flags: [], min: 1, max: 2 },
  "config set": { flags: [], min: 4, max: 4 },
  "schedules list": { flags: [], min: 1, max: 2 },
  "schedules add": { flags: ["name", "run-at", "prompt"], min: 2, max: 2 },
  "schedules remove": { flags: [], min: 3, max: 3 },
  "session list": { flags: [], min: 1, max: 2 },
  "session reset": { flags: [], min: 2, max: 3 },
  "slack login": { flags: [], min: 2, max: 2 },
  "slack logout": { flags: [], min: 2, max: 2 },
  "slack call": { flags: ["body"], min: 3, max: 3 },
  "slack upload-file": {
    flags: ["channel", "file", "thread-ts", "title", "comment"],
    min: 2,
    max: 2,
  },
  "slack download-file": { flags: ["file", "out"], min: 2, max: 2 },
  logs: { flags: ["limit"], min: 1, max: 1 },
  events: { flags: ["limit"], min: 1, max: 1 },
  doctor: { flags: [], min: 1, max: 1 },
}

export function validateCommand(parsed: CliArguments): void {
  const command = parsed.words[0] ?? ""
  const defaults: Record<string, string> = { config: "show", schedules: "list", session: "list" }
  const key = ["config", "schedules", "session", "slack"].includes(command)
    ? `${command} ${parsed.words[1] ?? defaults[command] ?? ""}`
    : command
  const definition = COMMANDS[key]
  if (!definition) throw new Error(`Unknown command: ${key}. Run leuco --help`)
  for (const flag of Object.keys(parsed.flags)) {
    if (!definition.flags.includes(flag)) throw new Error(`--${flag} is not supported by ${key}`)
  }
  if (parsed.words.length < definition.min || parsed.words.length > definition.max)
    throw new Error(`Invalid arguments for ${key}. Run leuco --help`)
}
