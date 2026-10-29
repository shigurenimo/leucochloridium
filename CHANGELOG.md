# Changelog

All notable changes to Leuco are documented here.

## 0.18.0 - Unreleased

### 変更

- 起動失敗のCLIエラーへ子PID・終了コード・signal・マスク済み直近ログを追加。制御情報の破損時は停止と断定せず、起動・状態リセットの誤案内を抑止。
- 停止受付の理由をイベントとテキストログへ記録。CLI停止のrequestId、OSシグナル、abort、内部異常、一回実行の完了を区別。

- doctorが停止中を正常と誤判定する問題を修正。Slack返信用CLIのPATH検査と、起動・bun link・PATH修正の案内を追加。

- FlumeClosed.errors()の停止失敗を検査し、終了未確認のソケット上に次の接続を開かないよう修正。watchdogの登録・解除失敗とconsumer例外を診断へ残す。

- Slack登録を一つずつコピーしたトークンのクリップボード読み取りだけへ限定し、手入力・stdin・トークン引数・interactive flagを廃止。読み取りのサイズと時間を制限。
- CLI所有のBotは未処理例外後に自動復旧し、60秒内3回で再起動ループを停止。起動識別情報と操作IDで古いworkerの誤操作を防止。

- 初期化中の停止、後片付けの失敗の隠蔽、元の原因の上書き、単発予定の自動再送を修正。Codexの初期化・停止を直列化し、終了未確認のプロセスを保持。
- 原因の連鎖・スタック・コード、入力接続の健全性、未処理例外の記録と終了処理を追加。イベントDB障害時は明示的なメモリ履歴とテキスト記録で継続。
- 障害注入の実プロセス検証と全検証scriptの型検査を追加。

- 結果を標準YAML / 任意JSONへ統一し、requestIdを追加。通常CLIの入力待ちを廃止し期限を設定。前面常駐は明示optionで選ぶ。
- 独立workerによるrestart、安全なrepair、診断・待ち行列・ログ保存健全性、依頼別イベント検索とログローテーションを追加。
- Flumeを0.12.0、publintを0.3.25へ更新。

- AI向けの個別helpとそのJSON版、JSON結果とエラーコードを追加。コマンド契約から引数検証とCLI.mdを生成し、生成差分と実CLIを検査。読み取り時にホームを生成せず、eventsをSQLiteの読み取り専用queryへ変更。

- 対応Bunを1.4.4以上へ変更し、Windowsの端末内資格情報保存を指定。
- Slack tokenをOS資格情報ストアへ保存し、起動時に一度だけ読む形へ変更。login / logoutとクリップボード登録を追加し、設定は参照IDだけに変更。Slack操作はdaemonへ中継し、ファイルIOは呼び出し元に維持。

- 一つのCodex app-serverを動かすCLIへ変更。project登録、supervisor、connector登録、旧boot管理とHTTP gatewayを廃止。
- 通常のCODEX_HOMEをそのまま使用。Codex設定の生成、認証symlink、内蔵prompt presetを廃止。
- 追加指示は明示的なSOULだけ。`--soul` / `--no-soul` で選択し、指示変更時は新しい会話を使う。
- 会話キーごとの再開と一つの直列queue、任意のSlack接続一つ、flatな予定管理を提供。
- Unix socketとtokenでローカル制御。失敗した依頼を再実行せず、次の依頼でCodex接続を復旧。
- 公開APIはLeucoRuntimeと単一設定・状態の型に整理。旧APIとの互換性はない。
- Zodと検証用ツールを修正版へ更新し、既存依存の脆弱性を解消。

## 0.17.6 - 2026-08-05

### Added

- 埋め込みconsumerが`LeucoRuntime.build()`の`hostInstructions`でstandalone Leuco CLI向けのprompt部分だけを置換できるように追加。Slackの宛先判定と明示書き込み境界は共通ルールとして維持。

## 0.17.5 - 2026-07-31

### Added

- Programmable APIの`LeucoRuntime.build()`で`codexAuthPath`を指定し、project別`CODEX_HOME`の挙動を変えずに任意のCodex認証を共有できるように追加。

## 0.17.4 - 2026-07-30

### Fixed

- cronのfire decisionをturn実行前に永続化し、保存失敗やCodex turn失敗後に同じoccurrenceを重複実行しないように修正。
- 壊れたproject `state.json`をsession resetでcanonicalな空stateへ置換し、CLIから復旧できるように修正。
- 実行中のSQLite Event Logでバイト上限を正しく計測し、長時間稼働中も古いeventを削除するように修正。
- Slack DM診断でthread replyを含む最新human messageを選び、最新turnより古いterminal eventを誤用しないように修正。

## 0.17.3 - 2026-07-30

### Fixed

- daemon readiness確認をglobal `fetch`から独立させ、失敗時にlog pathと原因を診断できるように修正。
- process identityの一時的な取得失敗をdaemon停止と誤認せず、`leuco status`が稼働中または置換後のPID leaseを削除しないように修正。
- project runtimeの停止失敗時は旧runtimeを保持して再試行し、停止完了前にreplacementを起動しないように修正。
- `LeucoRuntime.stop()`後の`start()`を明示的に拒否し、gatewayだけが再起動する半起動状態を防止。

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
