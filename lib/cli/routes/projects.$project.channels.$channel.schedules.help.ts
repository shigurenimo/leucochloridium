export const help = `leuco projects <p> channels <c> schedules / manage scheduled prompts

usage / leuco projects <p> channels <c> schedules [subcommand]

subcommands:
  list / print all entries
  add --name <n> --run-at <expr> --prompt <text> / register a new entry
  remove <id-or-name> / delete an entry by id or name

output / valid YAML

\`--run-at\` accepts either an ISO 8601 timestamp (one-shot, deleted after fire)
or a 5-field cron expression (recurring, never auto-deleted). The daemon picks
up changes within one tick (60 s) -- no restart needed.`
