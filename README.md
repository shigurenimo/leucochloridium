# Leuco

Leuco is a self-hosted gateway that runs the Codex `app-server` as a Slack bot. A single daemon on your machine supervises any number of projects, and each enabled project gets its own dedicated Codex process. You mention the bot in Slack, Codex works inside your repository, and the reply comes back to the same conversation.

Leuco runs on Bun only.

## How Leuco is organized

A project is the unit you register and configure: a repository you want Codex to work in, together with its execution settings. When a project is enabled, Leuco builds a tenant for it — an internal runtime unit that owns one Codex `app-server` process, one shared Codex thread, and the project's connection plugins. You never create or manage tenants directly.

```text
Leuco daemon
├─ project A
│  └─ tenant
│     ├─ Codex app-server × 1
│     ├─ shared Codex thread × 1
│     ├─ slack connection plugin
│     └─ schedule plugin
└─ project B
   └─ tenant
      └─ Codex app-server × 1
```

The word "channel" in the CLI does not mean a Slack channel like `#general`. It is a connection plugin attached to a project, and it comes in two kinds: `slack` and `schedule`. Public channels, private channels, DMs, and threads on the Slack side are ordinary Slack conversations — you do not register them individually in Leuco.

Everything inside one project shares a single Codex thread: every Slack connection, every Slack conversation and thread, and every schedule. If you want separate conversation histories, split the work into separate projects.

Current Leuco has no user-facing `agent` entity. Codex subagents, the macOS LaunchAgent, and the `agents[]` array found in old configuration files are all unrelated concepts.

## Requirements

You need [Bun](https://bun.sh) 1.3 or later, the [Codex CLI](https://github.com/openai/codex), and permission to install an app into your Slack workspace. Automatic startup at login uses `launchctl` and is macOS only.

## Installation

```bash
bun i -g leuco
leuco --version
codex login
```

To run from a checkout of this repository instead:

```bash
bun install
bun link
leuco --version
```

## Setting up the Slack app

This walkthrough covers the standard configuration using a bot user OAuth token (`xoxb-...`). If you would rather have the bot act as a real Slack user, see the user token section below.

### Create the app

Open [Slack Apps](https://api.slack.com/apps), choose `Create New App`, then `From scratch`, and pick an app name and the workspace to install into.

Under `OAuth & Permissions`, add the bot token scopes `app_mentions:read`, `channels:history`, `im:history`, `chat:write`, and `reactions:write`. If the bot should also receive every message in private channels, add `groups:history` as well. Slack documents each scope in its reference, for example [`app_mentions:read`](https://docs.slack.dev/reference/scopes/app_mentions.read/), [`chat:write`](https://docs.slack.dev/reference/scopes/chat.write/), and [`groups:history`](https://docs.slack.dev/reference/scopes/groups.history/).

### Subscribe to events

Under `Event Subscriptions`, enable events and subscribe to the bot events `app_mention`, `message.channels`, and `message.im`. Add `message.groups` if you need every message in private channels, `message.mpim` together with the `mpim:history` scope for group DMs, and `reaction_added` if you want the bot to observe reactions.

### Enable Socket Mode

Leuco connects to Slack over Socket Mode, so no public HTTP endpoint is required. Enable it under `Socket Mode`, then create an app-level token with the `connections:write` scope from `Basic Information` → `App-Level Tokens`, and keep the generated `xapp-...` token. Slack's [Socket Mode guide](https://docs.slack.dev/apis/events-api/using-socket-mode/) and the [`connections:write` reference](https://docs.slack.dev/reference/scopes/connections.write/) have the details.

### Install the app

Install the app into your workspace from `Install App` and keep the bot user OAuth token (`xoxb-...`). Whenever Slack asks you to reinstall after a scope or event change, do it — the old token keeps working with the old permissions otherwise.

## Registering a project

Run these from the root of the repository you want the bot to work in. The project name defaults to the directory name.

```bash
cd /path/to/your-repo
leuco projects add .
leuco channels add slack
```

The short form `leuco channels ...` only works from the root of a registered repository. From anywhere else, use the full form:

```bash
leuco projects <project-name> channels add slack
```

`leuco projects` and `leuco channels` show what is registered so far.

## Saving the Slack tokens

Tokens are read from standard input so they never end up in your shell history or process list. On macOS, copy the `xoxb-...` token to the clipboard and run:

```bash
pbpaste | leuco channels slack set-tokens --bot-token -
```

Then copy the `xapp-...` token and run:

```bash
pbpaste | leuco channels slack set-tokens --app-token -
```

Without `pbpaste`, run each command with `-`, paste the token, press Enter, then Ctrl-D.

Here `slack` is the name of the connection, not a fixed keyword. If you created the connection under a different name with `channels add slack --name work`, use that name instead.

Check the result with `leuco channels`. The connection is ready when it reports `tokensSet: true`:

```yaml
channels:
  - name: slack
    type: slack
    enabled: true
    tokensSet: true
```

Tokens are stored per connection in `~/.leuco/settings.json`. No runtime environment variables are needed for Slack.

## Running the bot

Start in the foreground the first time so you can read the logs directly:

```bash
leuco run
```

Once `ready` and the Slack connection lines appear, invite the bot to a channel and mention it:

```text
/invite @your-bot
@your-bot hello
```

For DMs, open a direct message with the app and write to it.

When everything works, stop the foreground process with Ctrl-C and switch to the background daemon:

```bash
leuco start
leuco status
```

Running plain `leuco` with no arguments starts the daemon if it is stopped and prints the status if it is already running. To start automatically at login on macOS:

```bash
leuco boot install
leuco boot
```

## Using a user token

Leuco also accepts a user token (`xoxp-...`). In that configuration, Slack API calls run as the token's owner rather than as a bot. Set the user token scopes `channels:history`, `im:history`, `im:read`, and `chat:write`, subscribe to `message.channels` and `message.im` as user events rather than bot events, and add `groups:history`, `mpim:history`, `message.groups`, or `message.mpim` as needed. The Socket Mode `xapp-...` token is required exactly as in the bot configuration.

For compatibility, the CLI stores a user token through the same `--bot-token` flag:

```bash
pbpaste | leuco channels slack set-tokens --bot-token -
```

## Everyday commands

The daemon lifecycle is managed with the top-level commands:

```text
leuco                         start if stopped, show status if running
leuco run                     run in the foreground
leuco start                   start in the background
leuco stop                    stop
leuco restart                 stop, then start
leuco kill                    stop the daemon and any leftover Codex processes
leuco status                  show daemon and project state as YAML
leuco logs -f                 follow the daemon log
leuco doctor                  diagnose settings, Codex, Slack, leftover processes
leuco update --check          check for a new version
leuco update                  update to the latest version
```

Projects are managed under `leuco projects`:

```text
leuco projects                            list registered projects
leuco projects add [<path>]               register an existing repository
leuco projects create <path>              scaffold a repository and register it
leuco projects <p> start                  enable the project
leuco projects <p> stop                   disable the project
leuco projects <p> restart                rebuild the tenant
leuco projects <p> rename <new>           rename the project
leuco projects <p> relocate <new-path>    move the repository and update the path
leuco projects <p> cwd <path>             change only Codex's cwd, moving no files
leuco projects <p> session                show the shared Codex thread state
leuco projects <p> session reset          discard the shared Codex thread and restart
leuco projects <p> path [key]             print project-related paths
leuco projects <p> remove [--cascade]     unregister
```

Connection plugins are managed under each project. From the root of a registered repository, `leuco projects <p>` can be omitted and the same commands are available as `leuco channels ...`:

```text
leuco projects <p> channels                         list connections
leuco projects <p> channels add slack               add a Slack connection
leuco projects <p> channels add schedule            add a schedule connection
leuco projects <p> channels <c> start               enable
leuco projects <p> channels <c> stop                disable
leuco projects <p> channels <c> restart             rebuild the tenant
leuco projects <p> channels <c> rename <new>        rename the connection
leuco projects <p> channels <c> set-tokens          update Slack tokens
leuco projects <p> channels <c> remove              remove the connection
```

## Schedules

A schedule connection fires prompts into the project's shared Codex thread on a timer:

```bash
leuco projects <p> channels <c> schedules list
leuco projects <p> channels <c> schedules add \
  --name one-shot-check \
  --run-at '2026-07-16T09:00:00+09:00' \
  --prompt 'Check the status and report to Slack'
leuco projects <p> channels <c> schedules remove one-shot-check
```

`--run-at` accepts either a five-field cron expression or an ISO 8601 timestamp. An ISO 8601 entry fires once and is removed afterwards; a cron entry persists and keeps firing. Schedule changes are picked up within sixty seconds and never require a tenant restart.

## Calling Slack directly

The CLI can call the Slack Web API and download files on a project's behalf:

```bash
leuco slack call chat.postMessage \
  --project <p> \
  --body '{"channel":"C0123","text":"hello"}'

leuco projects <p> channels <c> download-file \
  --file F0123 \
  --out ./download.bin
```

The same operations are exposed to Codex as MCP tools.

## How it works

Incoming Slack traffic follows one path:

```text
Slack Socket Mode
  → slack connection plugin
  → event validation, dedup, self-bot filtering
  → the project's tenant
  → the project-wide Codex thread
  → Codex calls the slack_call MCP tool
  → Slack Web API
```

Each enabled project runs exactly one Codex `app-server`, spawned over stdio JSON-RPC. All input is serialized into the project-wide Codex thread; messages that arrive while a turn is running are batched into the next turn. Slack messages reach Codex as structured input, and whether to reply is decided by the built-in prompt and Codex itself.

The return value of a Codex turn is never posted to Slack directly. A visible reply happens only when Codex calls the `slack_call` MCP tool. This keeps Codex in control of what, where, and whether to post.

A single turn has a wall-clock timeout of ten minutes. When a turn times out, the Codex child process is stopped and restarted. Each project gets its own `CODEX_HOME`, separating configuration and Codex memory per project; only the Codex login is shared, through a symlink to `~/.codex/auth.json`.

## Where data lives

```text
~/.leuco/
├─ settings.json
│  └─ machine-wide settings, projects, Slack tokens, Codex thread state
├─ daemon/
│  ├─ pid
│  ├─ log
│  └─ events.db
└─ projects/
   └─ <project-uuid>/
      └─ .codex/
         ├─ auth.json -> ~/.codex/auth.json
         └─ config.toml
```

`settings.json`, `events.db`, and each tenant's `config.toml` contain secrets or Slack message bodies, so Leuco restricts them to file mode 0600.

## Configuration

`LEUCO_CODEX_BIN` sets the path to the Codex executable and defaults to `codex`. `LEUCO_PORT` sets the port of the loopback MCP gateway and defaults to 7331.

`.env.local` and `.env` are read from the current directory only by `leuco run`. Other commands, including `leuco start`, deliberately ignore them so that secrets from an unrelated working directory never leak into the daemon environment. Variables already present in the process environment take precedence over both files.

`leuco config` prints the machine-wide settings as YAML. On macOS, `keepAwake` defaults to `true` and runs `caffeinate` alongside the daemon:

```bash
leuco config
leuco config set keepAwake false
```

## Troubleshooting

Start with the built-in diagnostics:

```bash
leuco doctor
leuco status
leuco events --preset errors
leuco logs -f
```

### botToken is empty

A Slack connection exists but no `xoxb-...` or `xoxp-...` token has been saved. Save one and check again:

```bash
pbpaste | leuco channels slack set-tokens --bot-token -
leuco channels
```

### appToken is empty

A Slack connection exists but no `xapp-...` token has been saved:

```bash
pbpaste | leuco channels slack set-tokens --app-token -
leuco channels
```

If you changed tokens while the daemon was running, restart the connection:

```bash
leuco channels slack restart
```

### auth.test fails

Make sure the value passed to `--bot-token` really is an `xoxb-...` or `xoxp-...` token, that the app was reinstalled into the workspace after any scope change, and that the token belongs to the right workspace. `leuco doctor` and `leuco logs -f` show the underlying Slack API error.

### The bot ignores mentions

Check that the `app_mention` event and the `app_mentions:read` scope are configured, that the bot has been invited to the Slack channel with `/invite @your-bot`, and that the `xapp-...` token carries `connections:write`. `leuco logs -f` shows whether the Socket Mode connection is up. In private channels, `groups:history` and `message.groups` are also required.

### The bot ignores DMs

Check the `message.im` event and the `im:history` scope. With a user token, `message.im` must be subscribed as a user event, not a bot event. The delivery path for a specific DM conversation (`D...`) can be diagnosed directly:

```bash
leuco slack dm D0123ABC --project <p>
```

A result of `socket_event_missing` means the message exists in Slack history but never reached Leuco over Socket Mode.

## Event log

Leuco writes structured events to `~/.leuco/daemon/events.db`:

```bash
leuco events
leuco events --type turn.complete
leuco events --project <p> --limit 50
leuco events --preset turns
leuco events --preset errors
leuco events --preset lifecycle
leuco events --preset schedule
leuco events --json
```

`leuco logs -f` follows the daemon's text log; `leuco events` reads the structured SQLite events.

## Using Leuco as a library

```ts
import { LeucoRuntime } from "leuco"

const runtime = LeucoRuntime.build({ env: process.env })
await runtime.start()
```

`LeucoRuntime`, `LeucoEngine`, `LeucoTenant`, `LeucoCodexClient`, `LeucoSlackChannelPlugin`, `LeucoChannelHost`, `LeucoEventBus`, `LeucoProjectStore`, and more are exported from the package root. Since Leuco itself is Bun-only, importing from a non-Bun runtime fails.

## License

MIT
