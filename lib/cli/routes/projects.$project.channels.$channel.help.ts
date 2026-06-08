export const help = `leuco projects <p> channels <c> / operations on a channel

usage / leuco projects <p> channels <c> [subcommand]

subcommands:
  remove / remove this channel
  rename <new> / rename this channel
  start / enable this channel
  stop / disable this channel
  restart / rebuild the tenant
  set-tokens [--bot-token <t>] [--app-token <t>] / update Slack tokens (\`-\` reads from stdin)
  schedules / manage entries on a schedule channel (add | list | remove)`
