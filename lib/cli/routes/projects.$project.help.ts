export const help = `leuco projects <p> / operations on a registered project

usage / leuco projects <p> [subcommand]

subcommands:
  remove [--cascade] / unregister this project
  rename <new> / rename
  relocate <new-path> / move repo dir + update path
  start / enable
  stop / disable
  restart / rebuild the tenant
  reset / drop codex thread (memories preserved)
  channels / manage channels (run \`leuco projects <p> channels -h\`)`
