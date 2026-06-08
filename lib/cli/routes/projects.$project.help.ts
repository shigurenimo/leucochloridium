export const help = `leuco projects <p> / operations on a registered project

usage / leuco projects <p> [subcommand]

subcommands:
  remove [--cascade] / unregister this project
  rename <new> / rename this project
  relocate <new-path> / move the repo dir + update path
  start / enable this project
  stop / disable this project
  restart / rebuild the tenant
  reset / drop codex thread (memories preserved)
  channels / list channels in this project
  channels add (slack|schedule) / add a channel
  channels <c> ... / operate on a specific channel`
