export const help = `leuco — Self-hosted gateway bridging chat channels to codex app-server.

usage:
  leuco                            open the TUI when running, otherwise start the daemon in background
  leuco start                      start the daemon; reads every ~/.leuco/projects/<p>/settings.json
  leuco run                        run in foreground (debug; logs to stdout)
  leuco stop                       stop the daemon
  leuco restart                    stop + start
  leuco status                     show daemon + per-project state
  leuco logs [-f]                  print log file (-f to follow)
  leuco update [--check]           install the latest published leuco (or just check the registry)

  leuco projects list                                 list registered projects
  leuco projects create <path>                        scaffold a new repository (mkdir + git init + register)
  leuco projects add [<path>]                         register an existing repository
  leuco projects <p> remove [--cascade]               unregister a project
  leuco projects <p> rename <new>                     rename a project (also moves ~/.leuco/projects/<p>/)

  leuco projects <p> agents list                      list agents in <p>
  leuco projects <p> agents add <a>                   create .codex/agents/<a>.toml + register
  leuco projects <p> agents <a> remove [--cascade]    remove an agent
  leuco projects <p> agents <a> rename <new>          rename agent + TOML + codex-home (memories survive)
  leuco projects <p> agents <a> start                 enable an agent (daemon reload)
  leuco projects <p> agents <a> stop                  disable an agent (daemon reload, memories preserved)
  leuco projects <p> agents <a> restart               rebuild this agent's tenant to pick up persona / token / ack changes
  leuco projects <p> agents <a> reset                  drop the codex thread id (codex memories preserved)

  leuco projects <p> agents <a> channels list                          list channels under <a>
  leuco projects <p> agents <a> channels add slack                     register a slack channel under <a>
  leuco projects <p> agents <a> channels <c> remove                    remove a channel
  leuco projects <p> agents <a> channels <c> rename <new>              rename a channel
  leuco projects <p> agents <a> channels <c> start                     enable a channel
  leuco projects <p> agents <a> channels <c> stop                      disable a channel
  leuco projects <p> agents <a> channels <c> restart                   rebuild the parent tenant
  leuco projects <p> agents <a> channels <c> set-tokens                update Slack bot / app tokens (\`-\` reads one from stdin)

  leuco config list                                            print every key in ~/.leuco/settings.json
  leuco config get <key>                                       print one key
  leuco config set <key> <value>                               write one key

  leuco boot install                                           macOS only: install LaunchAgent so the daemon starts at login
  leuco boot uninstall                                         remove the LaunchAgent
  leuco boot status                                            show LaunchAgent install + load state

  leuco slack call <method> --project <p> --agent <a> [--body '<json>'] [--channel <c>]
                                                              forward a Slack Web API call (same surface as the MCP slack_call tool)
  leuco mcp --project <p> --agent <a>                          stdio MCP server (spawned by codex; not for direct use)

cwd shortcut: when invoked from inside a registered project's path, you can drop the
\`projects <p>\` prefix — \`leuco agents list\` works as \`leuco projects <p> agents list\`.

Layout:
  daemon:   ~/.leuco/daemon/{pid,log}                     (machine-wide, single process)
  global:   ~/.leuco/settings.json                        (machine-wide; \`leuco config set\`)
  project:  ~/.leuco/projects/<p>/settings.json           (chmod 600, registration + tokens)
  codex:    ~/.leuco/projects/<p>/agents/<a>/home/        (CODEX_HOME, memories)

env (optional):
  LEUCO_CODEX_BIN                  codex binary path (default: "codex")
  LEUCO_PORT                       HTTP gateway port (default: 7331)

env files (read from cwd at CLI invocation, not overriding existing env):
  .env.local                       developer-local LEUCO_* overrides
  .env                             committed defaults

options:
  --help, -h                       show help
  --version, -v                    show version`
