export const help = `leuco projects <p> agents <a> channels <c> schedules — manage scheduled prompts

usage:
  leuco projects <p> agents <a> channels <c> schedules add    --name <n> --run-at <expr> --prompt <text>
  leuco projects <p> agents <a> channels <c> schedules list
  leuco projects <p> agents <a> channels <c> schedules remove <id-or-name>

  add                         register a new entry on the schedule channel
  list                        print all entries (id, name, runAt, enabled)
  remove                      delete an entry by id or name

\`--run-at\` accepts either an ISO 8601 timestamp (one-shot, deleted after fire)
or a 5-field cron expression (recurring, never auto-deleted). The daemon picks
up changes within one tick (60 s) — no restart needed.`
