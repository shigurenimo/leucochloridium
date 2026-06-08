export const help = `leuco / self-hosted codex-to-slack gateway

usage / leuco <command> [-h]

commands:
  start / start daemon in background
  run / run in foreground
  stop / stop daemon
  restart / stop + start
  status / daemon + project state
  logs / print log (-f to follow)
  update / install latest version
  projects / manage projects and channels
  config / machine-wide settings
  boot / macOS LaunchAgent
  slack / forward Slack API calls
  mcp / stdio MCP server

options:
  -h, --help / show help
  -v, --version / show version

run \`leuco <command> -h\` for details.`
