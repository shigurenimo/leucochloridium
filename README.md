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

`leuco` (no args) prints `leuco status` output when the daemon is running
and otherwise spawns the daemon in the background.

## Commands

Daemon:

```
leuco                     print status when running, otherwise start the daemon
leuco start               start the daemon in background
leuco run                 run in foreground (debug; logs to stdout)
leuco stop                stop the daemon
leuco restart             stop + start
leuco status              daemon + per-project state
leuco logs [-f]           print daemon log (-f to follow)
leuco update [--check]    install the latest published leuco (--check only reports the registry)
```

Project management:

```
leuco projects list
leuco projects create <path>            mkdir + git init + register
leuco projects add [<path>]             register an existing repo
leuco projects <p> remove [--cascade]
leuco projects <p> rename <new>
leuco projects <p> relocate <new-path>
leuco projects <p> start
leuco projects <p> stop
leuco projects <p> restart
leuco projects <p> reset               clear codex thread + restart
```

Channel management:

```
leuco projects <p> channels list
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
leuco projects <p> channels <c> schedules add <name> --run-at '<cron>' --prompt '<text>'
leuco projects <p> channels <c> schedules remove <name>
```

Cwd shortcut: when invoked from inside a registered project's path you can
drop the `projects <p>` prefix -- `leuco channels list` resolves to
`leuco projects <p> channels list`.

Other entry points:

```
leuco slack call <method> --project <p> [--body '<json>'] [--channel <c>]
leuco mcp --project <p>     # stdio MCP server (spawned by codex)
```

## How it works

```
Slack (Socket Mode) --> leuco daemon --> codex app-server (one process per project)
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
  settings.json                          machine-wide settings
  daemon/
    pid
    log
    events.jsonl                         newline-delimited LeucoEvent stream
  projects/
    <uuid>/
      settings.json                      project config + per-channel tokens (chmod 600)
      state.json                         runtime state (codex thread id etc.)
      .codex/                            CODEX_HOME for this tenant
        auth.json                        symlink -> ~/.codex/auth.json
        config.toml                      project trust + mcp_servers.leuco
```

## Requirements

- [Bun](https://bun.sh) 1.3+
- `codex` CLI on `PATH`, signed in via `codex login`
- A Slack App in Socket Mode
  - Bot scopes: `app_mentions:read`, `chat:write`, `reactions:write`
  - Event subscriptions: `app_mention`, `message.channels` (optionally `reaction_added`)
  - App-level token with `connections:write`

## Environment variables

- `LEUCO_CODEX_BIN` -- Codex binary path (default: `codex`)
- `LEUCO_PORT` -- HTTP gateway port for IPC (default: off; e.g. `9743`)
- `LEUCO_CWD` -- Override Codex working directory (default: project path)

`.env.local` and `.env` are read from the cwd at CLI invocation. Existing
process env wins over the files.

Per-channel Slack tokens (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`) are stored in
`~/.leuco/projects/<id>/settings.json` and are entered via
`leuco projects <p> channels add slack` -- no env vars required at runtime.

## Event log

The daemon writes a newline-delimited JSON stream to
`~/.leuco/daemon/events.jsonl`. `leuco logs -f` tails it; any consumer can
tail the same file directly.

Event types: `tenant.started`, `tenant.stopped`, `engine.reconcile`,
`slack.event`, `turn.start`, `turn.complete`, `turn.error`,
`codex.notification`, `log`. See `lib/events/leuco-event-types.ts`.

## Library usage

```ts
import { LeucoRuntime } from "leuco"

const runtime = LeucoRuntime.build({ env: process.env })
if (runtime instanceof Error) throw runtime

const start = await runtime.start()
if (start instanceof Error) throw start
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
- Bot is not invited to the channel (`/invite @yourbot`)
- App-level token is missing `connections:write`
- Channel has `ackMode: "off"` and the bot returned empty text

## License

MIT
