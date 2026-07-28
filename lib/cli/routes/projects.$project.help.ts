export const help = `leuco projects <p> / operations on a registered project

usage / leuco projects <p> [subcommand]

subcommands:
  remove [--cascade] / unregister this project
  rename <new> / rename
  cwd <path> / change the project working directory without moving files
  start / enable
  stop / disable
  restart / rebuild the project runtime
  session / show, scope, or reset Codex sessions
  path [key] / print project filesystem paths
  connectors / manage connectors (run \`leuco projects <p> connectors -h\`)`
