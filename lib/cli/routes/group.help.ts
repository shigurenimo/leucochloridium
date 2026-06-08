export const help = `leuco / self-hosted gateway bridging chat channels to codex app-server

usage / leuco [subcommand]

subcommands:
  (none) / start daemon or show TUI if already running
  start / start the daemon in background
  run / run in foreground (debug; logs to stdout)
  stop / stop the daemon
  restart / stop + start
  status / show daemon + per-project state
  logs [-f] / print log file (-f to follow)
  update [--check] / install the latest published leuco

  projects / list registered projects
  projects create <path> / scaffold a new repository
  projects add [<path>] / register an existing repo
  projects <p> remove [--cascade] / unregister a project
  projects <p> rename <new> / rename a project
  projects <p> start / enable a project
  projects <p> stop / disable a project
  projects <p> restart / rebuild the tenant
  projects <p> reset / drop the codex thread

  projects <p> channels / list channels
  projects <p> channels add (slack|schedule) / add a channel
  projects <p> channels <c> remove / remove a channel
  projects <p> channels <c> start / enable a channel
  projects <p> channels <c> stop / disable a channel

  config / print machine-wide settings
  config get <key> / print one key
  config set <key> <value> / write one key

  boot install / macOS: install LaunchAgent
  boot uninstall / remove the LaunchAgent
  boot status / show LaunchAgent state

  slack call <method> --project <p> [--body '<json>'] [--channel <c>] / forward a Slack Web API call
  mcp --project <p> / stdio MCP server (spawned by codex)

cwd shortcut: inside a registered project's path, drop the \`projects <p>\` prefix.

output / valid YAML (structured commands) or plain text (actions)

options:
  --help, -h / show help
  --version, -v / show version`
