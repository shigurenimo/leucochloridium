export const help = `leuco / self-hosted codex-to-slack gateway

usage / leuco <command> [-h]

commands:
  start / start daemon in background
  run / run in foreground
  stop / stop daemon
  kill / kill daemon and all codex processes
  restart / stop + start
  status / daemon + project state
  logs / print log (-f to follow)
  events / query event log (--preset, --type, --project)
  update / install latest version
  doctor / diagnose daemon, projects, and channels
  projects / manage projects and channels
  config / machine-wide settings
  boot / macOS LaunchAgent
  slack / forward Slack API calls

diagnosis (something is wrong?):
  leuco doctor              run all checks and report issues
  leuco status              is the daemon running? which projects are active?
  leuco events --preset errors    any turn errors or reconcile failures?
  leuco events --preset turns     what did codex do recently?
  leuco logs -f             watch the diagnostic log in real time

options:
  -h, --help / show help
  -v, --version / show version

run \`leuco <command> -h\` for details.`
