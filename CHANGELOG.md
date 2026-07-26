# Changelog

All notable changes to Leuco are documented here.

## 0.15.1 - 2026-07-26

### Changed

- Let `leuco slack dm --project <name>` discover and diagnose the latest human DM without requiring a conversation ID.
- Include daemon and Slack connection state in DM diagnostics, with token-specific remediation when Socket Mode delivery is missing.

## 0.15.0 - 2026-07-26

### Added

- Detect Codex turns that stop producing notifications and replace the stalled child.
- Apply the hard turn deadline while starting or resuming Codex threads, and reject stale replies from replaced children.
- Bound queued turns by count and UTF-8 bytes, with structured overload events.
- Record turn queue depth, wait time, batch size, duration, and Codex recovery outcomes.
- Add the `recovery` event-log preset.
- Make hard and idle turn timeouts configurable through machine-wide settings.
- Bound structured event-log age, rows, file size, and persisted turn payloads.
- Export constructor option types, configuration schemas, and event schemas from the package root.
- Add cross-platform CI, package isolation checks, coverage floors, and dependency auditing.

### Changed

- Update Funnel, Flume, Hono, and Vite Plus.
- Correct package repository metadata and include the MIT license.
- Publish self-contained declaration files that resolve outside the source repository.

### Security

- Pin patched transitive versions for known Hono, body-parser, fast-uri, and PostCSS advisories.
- Reduce the dependency audit result from fifteen known vulnerabilities to zero.
