# Leuco

Self-hosted gateway that bridges chat channels (Slack today) to the
[Codex](https://github.com/openai/codex) `app-server`. One machine-wide
daemon supervises every registered project, each running as an isolated
tenant with its own `CODEX_HOME`.

## Install

```bash
bun i -g leuco
```

leuco is Bun-only. Install Bun from <https://bun.sh> first.

To work from a checkout instead:

```bash
bun install
bun link              # exposes the `leuco` bin from this checkout
```

## Quick start

```bash
cd your-repo
leuco projects add .  # register the cwd as a leuco project
leuco                 # starts the daemon (or prints status if already running)
```

`leuco` (no args) starts the daemon in the background, or prints status
when it is already running.

## Commands

Run `leuco <command> -h` for details on any command.

Daemon:

```
leuco start               start daemon in background
leuco run                 run in foreground
leuco stop                stop daemon
leuco restart             stop + start
leuco status              daemon + project state
leuco logs [-f]           print daemon log (-f to follow)
leuco events              query event log (--preset, --type, --project, --limit, --json)
leuco update [--check]    install latest version
```

Project management:

```
leuco projects                          list registered projects
leuco projects create <path>            scaffold + register a new repo
leuco projects add [<path>]             register an existing repo
leuco projects <p> remove [--cascade]
leuco projects <p> rename <new>
leuco projects <p> relocate <new-path>
leuco projects <p> start
leuco projects <p> stop
leuco projects <p> restart
leuco projects <p> session              show codex session state
leuco projects <p> session reset        clear codex session + restart
```

Channel management:

```
leuco projects <p> channels             list channels
leuco projects <p> channels add slack
leuco projects <p> channels add schedule
leuco projects <p> channels <c> remove
leuco projects <p> channels <c> rename <new>
leuco projects <p> channels <c> start
leuco projects <p> channels <c> stop
leuco projects <p> channels <c> restart
leuco projects <p> channels <c> set-tokens
```

Schedule entries (schedule channels only):

```
leuco projects <p> channels <c> schedules list
leuco projects <p> channels <c> schedules add --name <n> --run-at '<cron>' --prompt '<text>'
leuco projects <p> channels <c> schedules remove <name>
```

Cwd shortcut: inside a registered project's path, drop the `projects <p>`
prefix -- `leuco channels list` works as `leuco projects <p> channels list`.

Other:

```
leuco slack call <method> --project <p> [--body '<json>'] [--channel <c>]
leuco config [get <key> | set <key> <value>]
leuco boot [install | uninstall]
```

Structured commands (`status`, `projects`, `channels`, `schedules list`,
`config`, `boot`) output valid YAML. Action commands return plain text.

## How it works

```
Slack (Socket Mode) --> leuco daemon --> codex app-server (one per project)
                            |                    |
                            |   thread/start { cwd: <project.path> }
                            |   turn/start  { input: [{type:"text", text}] }
                            v
                       chat.postMessage (in thread)
```

- One daemon per machine; the daemon supervises every enabled project as a
  tenant.
- Each tenant has a dedicated `CODEX_HOME` under
  `~/.leuco/projects/<id>/.codex/`. `auth.json` is symlinked from
  `~/.codex/auth.json` so all tenants share the user's codex login while
  keeping memories isolated.
- One Slack thread maps to one Codex thread. Turns within a thread serialise;
  separate threads run in parallel.
- Mention gating, ack reactions, and bot-message filtering are configurable
  per channel (`ackMode: off | mention | always`, custom `ackIcons`).
- Codex subagents (`.codex/agents/*.toml`) are managed by codex, not leuco.

## Filesystem layout

```
~/.leuco/
  settings.json                          config + projects array (chmod 600)
  daemon/
    pid
    log
    events.db                            SQLite event log (WAL mode)
  projects/
    <uuid>/
      .codex/                            CODEX_HOME for this tenant
        auth.json                        symlink -> ~/.codex/auth.json
        config.toml                      project trust + mcp_servers.leuco
```

## Requirements

- [Bun](https://bun.sh) 1.3+
- `codex` CLI on `PATH`, signed in via `codex login`
- A Slack App in Socket Mode
  - Bot-token apps: bot scopes `app_mentions:read`, `channels:history`, `im:history`,
    `chat:write`, `reactions:write`; bot events `app_mention`, `message.channels`,
    `message.im` (optionally `reaction_added`)
  - User-token apps (`xoxp-*`, acting as the user): user scopes `channels:history`,
    `im:history`, `im:read`, `chat:write`; user events `message.channels`,
    `message.im` (optionally `message.groups`, `message.mpim`, reactions)
  - App-level token with `connections:write`

## Environment variables

- `LEUCO_CODEX_BIN` -- Codex binary path (default: `codex`)
- `LEUCO_PORT` -- HTTP gateway port, 1-65535 (default: `7331`)
- `LEUCO_CWD` -- Override Codex working directory (default: project path)

`.env.local` and `.env` are read from the cwd at CLI invocation. Existing
process env wins over the files.

Per-channel Slack tokens (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`) are stored in
`~/.leuco/settings.json` and are entered via
`leuco projects <p> channels add slack` -- no env vars required at runtime.

## Event log

The daemon persists structured events to `~/.leuco/daemon/events.db` (SQLite,
WAL mode). Query with:

```bash
leuco events                              # latest 20 events
leuco events --type turn.complete         # filter by type
leuco events --project myapp --limit 50   # filter by project
leuco events --json                       # raw JSON lines
```

`leuco logs -f` tails the daemon diagnostic log (`~/.leuco/daemon/log`), not
the event log.

Event types: `tenant.started`, `tenant.stopped`, `engine.reconcile`,
`engine.reconcile.failed`, `slack.event`, `slack.connection`, `slack.error`,
`turn.start`, `turn.complete`, `turn.error`, `codex.notification`,
`schedule.fired`, `log`.
See `lib/events/leuco-event-schema.ts`.

Presets group common queries:

```bash
leuco events --preset turns       # codex turn lifecycle
leuco events --preset errors      # turn errors + reconcile + slack errors
leuco events --preset lifecycle   # tenant + reconcile + slack connection
leuco events --preset schedule    # cron / one-shot firings
```

## Library usage

```ts
import { LeucoRuntime } from "leuco"

const runtime = LeucoRuntime.build({ env: process.env })
await runtime.start()
```

Lower-level building blocks (`LeucoEngine`, `LeucoTenant`,
`LeucoCodexClient`, `LeucoSlackChannelPlugin`, `LeucoChannelHost`,
`LeucoEventBus`, `LeucoProjectStore`, ...) are exported from the package
entry point. Every IO boundary is a port type so tests can substitute fakes.

## Troubleshooting

```bash
leuco stop
leuco run               # foreground, logs to stdout
```

Common causes when nothing happens on mention:

- Slack App is missing the `app_mention` event subscription
- Slack App is missing the `message.im` event subscription for DMs
  - For user-token apps, `message.im` must be under user events, not bot events.
- Bot is not invited to the channel (`/invite @yourbot`)
- App-level token is missing `connections:write`
- Channel has `ackMode: "off"` and the bot returned empty text

## License

MIT
