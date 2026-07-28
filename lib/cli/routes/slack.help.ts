export const help = `leuco slack / forward Slack Web API calls using a project's stored token

usage / leuco slack call <method> [--project <p>] [--body '<json>'] [--connector <c>]
        leuco slack dm [conversation-id] [--project <p>] [--limit <N>] [--json]

options:
  <method> / Slack Web API method (e.g. chat.postMessage)
  --body '<json>' / JSON body forwarded as the method arguments
  --project / project whose stored bot token is used; optional inside a project runtime
              Codex session and required otherwise
  --connector / pick a specific Slack connector when the project has multiple

DM diagnosis:
  leuco slack dm / automatically inspect the newest human DM and compare it
                   with daemon, Socket Mode, turn, and reply telemetry

For connector-scoped file downloads, use:
  leuco projects <p> connectors <c> download-file (--file <id>|--url <url>) --out <path>`
