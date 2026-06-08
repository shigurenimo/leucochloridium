---
name: leuco-cli
description: Use the leuco CLI to manage the leuco daemon, projects, and channels.
---

# Leuco

Leuco is a multi-tenant gateway that bridges chat channels (Slack today) to the Codex `app-server`. One daemon per machine supervises every registered project as an isolated tenant.

## CLI

The `leuco` command is on `PATH`. Every subcommand accepts `-h` for usage details.

```
leuco -h
leuco projects -h
leuco projects <p> channels -h
```

Start here:

- `leuco` — starts the daemon, or opens the TUI if already running.
- `leuco status` — quick health check.
- `leuco events` — query the structured event log.

## ~/.leuco

All state lives under `~/.leuco/`. Paths are computed by `LeucoPaths` — never assemble by hand.

```
~/.leuco/
├── settings.json          config + projects array (chmod 600)
├── daemon/
│   ├── pid
│   ├── log
│   └── events.db          SQLite event log
└── projects/
    └── <uuid>/
        └── .codex/         CODEX_HOME for this tenant
```

## When you are the agent inside a tenant

If your `CODEX_HOME` is under `~/.leuco/projects/`, you are a leuco-supervised tenant. The MCP server named `leuco` in your `config.toml` is the daemon that supervises you.
