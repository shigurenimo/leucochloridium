# Changelog

All notable changes to Leuco are documented here.

## 0.17.2 - 2026-07-29

### Fixed

- `exec-UUID`形式のcommand output overflowでも、繰り返し失敗するCodex threadを破棄して復旧。
- 誤って削除されていた`leuco update`と`--check`を復旧し、公開前versionからのdowngradeを防止。
- 0.17より前のEvent Logをread boundaryで現行のruntime、supervisor、connector形式へ正規化。
- `leuco doctor`の出力からSlack tokenの断片を除去。

## 0.17.1 - 2026-07-29

### Fixed

- Codexのfinal answerをSlackへ自動投稿せず、すべてのSlack書き込みを明示的なproject scope付き`leuco slack call`に限定。

## 0.17.0 - 2026-07-28

### Added

- ホストのsleep復帰後に停止したSlack Socket Mode接続を検知し、安全に再接続。
- 汎用Event Logとmemory、SQLite実装をLeuco本体で提供。

### Changed

- package rootの公開APIを、runtime、project、connector、Event Logの安定した契約に整理。
- channelをconnectorへ、Event JournalをEvent Logへ改称。
- Funnelへの依存を削除し、runtimeとCLIの責務を簡素化。

## 0.16.1 - 2026-07-28

### Fixed

- 0.16より前の数値PIDファイルを、安全確認後にupdate、restart、stop、reload前に移行。
- `leuco doctor` でversion付きdaemon PID leaseを正しく診断。

## 0.16.0 - 2026-07-28

### Changed

- Leuco内蔵MCP serverを廃止し、Slack、file、schedule操作をproject scope付きCLIへ一本化。
- Codex子へ `LEUCO_PROJECT_ID` を渡し、別projectを明示したCLI操作を実行前に拒否。
- system promptとtenant設定から内蔵MCP tool、endpoint、bearer tokenを削除。利用者設定の外部MCPは維持。

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
