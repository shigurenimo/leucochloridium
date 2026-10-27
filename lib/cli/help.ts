export const HELP = `leuco / one local Codex companion

usage:
  leuco run [--cwd <path>] [--soul <path> | --no-soul]
  leuco run --prompt <text> [--thread <key>]
  leuco start [run options]
  leuco stop
  leuco status
  leuco ask <text> [--thread <key>]
  leuco session list | reset [key]
  leuco config show | set <key> <json | ->
  leuco schedules list | add --name <name> --run-at <cron-or-iso> --prompt <text>
  leuco schedules remove <name-or-id>
  leuco slack login | logout
  leuco slack call <method> --body <json>
  leuco slack upload-file --channel <id> --file <path> [--thread-ts <ts>]
  leuco slack download-file --file <id> --out <path>
  leuco logs [--limit <lines>]
  leuco events [--limit <entries>]
  leuco doctor

run options:
  --cwd <path> / working directory (default: saved cwd or current directory)
  --soul <path> / append this file to the native Codex instructions
  --no-soul / ignore the saved soul file for this invocation
  --model <model> / optional model override; otherwise use Codex settings
  --codex-bin <path> / optional Codex executable

storage:
  LEUCO_HOME / Leuco settings and state (default: ~/.leuco)
  CODEX_HOME / inherited unchanged; Codex defaults to ~/.codex

No projects or connector registrations. No generated Codex configuration.
Configuration changes require restart, except schedules, which reload each minute.
Slack tokens are stored in the OS credential store; login requires an interactive terminal.
Slack operations require the daemon. Slack final answers are internal; posting requires an explicit leuco slack call.`
