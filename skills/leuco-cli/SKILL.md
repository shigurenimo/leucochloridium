---
name: leuco-cli
description: Use the leuco CLI to manage the leuco daemon, projects, agents, and channels.
---

# Leuco

Leuco is a multi-tenant gateway. One daemon per machine supervises every registered `(project, agent)` pair and bridges each one to a chat channel (Slack today). Each tenant runs its own Codex `app-server` with an isolated `CODEX_HOME`, so memories stay separate while every tenant shares the user's `~/.codex/auth.json` login.

## When to use this skill

- User mentions `leuco`, the daemon, the live TUI, or any path under `~/.leuco/`.
- User asks about registering a project, adding an agent, wiring a Slack channel, or starting/stopping the daemon.
- You are running inside a tenant. Tells: `CODEX_HOME` is under `~/.leuco/projects/<p>/agents/<a>/home/`, or `config.toml` declares an MCP server named `leuco`.

## CLI is the primary surface

Don't memorise commands. Every node accepts `--help`, and that is the source of truth.

```
leuco --help
leuco projects --help
leuco projects add --help
leuco projects <p> agents <a> channels add --help
```

Useful entry points:

- Bare `leuco` opens the live event TUI when the daemon is running, otherwise it starts the daemon in the background. ESC, `q`, or Ctrl-C exits the TUI.
- `leuco run` is the foreground/debug variant. Logs go to stdout, Ctrl-C stops it.
- `leuco status` and `leuco logs -f` are the first checks when something looks wrong.
- From inside a registered project's path, drop the `projects <p>` prefix: `leuco agents list`, `leuco agents <a> channels list`, etc.

## ~/.leuco layout

Everything leuco owns lives under `~/.leuco/` and is computed via `LeucoPaths` — never assemble these paths by hand.

```
~/.leuco/
├── settings.json                          machine-wide settings
├── daemon/
│   ├── pid                                daemon pid (one per machine)
│   ├── log                                daemon stdout/stderr
│   └── events.jsonl                       newline-delimited LeucoEvent stream
└── projects/
    └── <projectName>/
        ├── settings.json                  project config + per-channel tokens (chmod 600)
        └── agents/
            └── <agentName>/
                └── home/                  CODEX_HOME for this tenant
                    ├── auth.json          symlink → ~/.codex/auth.json
                    └── config.toml        project trust + mcp_servers.leuco
```

Invariants worth knowing:

- `events.jsonl` is the source of truth for everything the TUI shows. Any consumer can `tail -f` it without running the TUI.
- `projects/<p>/settings.json` is `chmod 600` because it stores Slack bot and app-level tokens.
- `auth.json` is symlinked, not copied — every tenant shares the user's Codex login while keeping memories isolated under its own `CODEX_HOME`.
- One Slack thread maps to one Codex thread. Turns within a thread serialise; separate threads run in parallel.

## When you are the agent inside a tenant

If your `CODEX_HOME` is under `~/.leuco/...`, you are a leuco-supervised tenant.

- The MCP server named `leuco` in your `config.toml` is the same daemon that supervises you. You can call its tools to inspect state.
- `AGENTS.md` and `AGENTS.override.md` in the project root, plus any files listed in `~/.codex/config.toml`'s `project_doc_fallback_filenames`, are picked up automatically.
- The cwd Codex sees is the project's `path` from `~/.leuco/projects/<p>/settings.json` unless `LEUCO_CWD` overrides it.
- Treat the user-visible chat channel (e.g., a Slack thread) as the authoritative conversation context.

## Troubleshooting

```
leuco stop && leuco run
```

runs the daemon in the foreground so you can see crashes directly. Common silent-failure causes:

- Slack App is missing the `app_mention` event subscription, or the app-level token lacks `connections:write`.
- Bot is not invited to the channel (`/invite @yourbot`).
- Channel `ackMode` is `off` and the agent returned empty text — nothing visible happens.

The README at the repo root has the full reference. This skill is the primer; reach for `--help` and the README when you need depth.
