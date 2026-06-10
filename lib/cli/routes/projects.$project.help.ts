export const help = `leuco projects <p> / operations on a registered project

usage / leuco projects <p> [subcommand]

subcommands:
  remove [--cascade] / unregister this project
  rename <new> / rename
  relocate <new-path> / move repo dir + update path
  start / enable
  stop / disable
  restart / rebuild the tenant
  session / show or reset Codex session
  reset / deprecated alias for session reset
  path [key] / print project filesystem paths
  channels / manage channels (run \`leuco projects <p> channels -h\`)`
