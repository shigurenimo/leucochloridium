# CLAUDE.md

Leucoは一匹のCodexを常駐させるBun専用CLI。使い方は [README.md](README.md)、アクセス境界は [SECURITY.md](SECURITY.md)。

## 現行モデル

`LeucoRuntime` が唯一の合成root。Codex app-serverを一つ、直列queueを一つ持つ。会話キーごとにCodex threadを対応付ける。Slack接続一つとscheduleは任意の入力経路で、ユーザー向けproject / connector登録は廃止した。

Codex子は親の環境変数を引き継ぐ。`CODEX_HOME` を書き換えず、設定や認証のコピー・symlinkを作らない。標準では追加のdeveloper instructionsなし。選択されたSOULだけをCodex設定のdeveloper instructionsへ追加する。権限・sandboxの上書きは禁止。

## ソース

- `lib/cli/command-catalog.ts` がAI向けコマンド契約の正本。parser / validator / help / CLI.mdは同じ定義を使う。
- `lib/cli/` はflat command、YAML / JSON結果・エラー、設定とSlack操作。
- `lib/maintenance/` は独立した再起動worker、操作journal、安全な修復。資格情報を記録しない。
- `lib/config/` はversion 4の単一設定schema。
- `lib/secrets/` はOS資格情報ストアのabstract / Bun / Memory実装。平文fallbackなし。
- `lib/storage/` は設定と状態のabstract store、Node / Memory実装。更新はlock内fresh loadとatomic write。
- `lib/daemon/` はlease、Unix socket、認証付きローカル制御、前面・背景起動。
- `lib/runtime/runtime.ts` は単一の待ち行列と稼働・停止。`leuco-conversations.ts` は会話再開と指示context、`build-runtime-connections.ts` は接続の組み立て。
- `lib/engine/` はCodex stdio JSON-RPCとturnの収集。
- `lib/connectors/` は内部のSlack / schedule入力。複数agentの管理ではない。
- `lib/actions/slack/` はtokenを保持するdaemon内のSlack API操作。ファイルの読み書きは呼び出し元CLIで行う。
- `lib/events/` はLeucoイベントとSQLite保守。
- `lib/event-log/` はFunnelとsourceを共有する汎用event log。このディレクトリ変更時は両製品のsource同期が必要。LeucoにFunnelのpackage依存はない。
- `scripts/verify-single-companion.ts` は実CLIと偽Codexの統合検証。

## 不変条件

- `~/.codex` は通常のCodex資産。Leuco独自configを生成しない。
- 指示や実行contextが変わった場合は新しいthreadにし、古いSOULを再開しない。
- cron・単発の受付は実行前に保存する。失敗した依頼を自動で再実行しない。任意のresume失敗で対応表を消さない。
- 全入力は一つのqueueで直列実行する。停止時は待機依頼も完了させる。
- Slack final answerは内部出力。本文の送信は明示的な `leuco slack call`。ack reactionは独立した設定可能な動作。
- 設定には資格情報の参照IDだけを保存する。tokenはOSストアから起動時に一度だけ読み、Codexへ渡さない。設定と状態は0600、ホームは0700。
- `settings.json` は設定、`state.json` は会話対応表と予定実行時刻。古いsnapshotの上書きをしない。

## 検証

`bun run verify` を使う。CLI定義変更後は `bun run docs:cli` でCLI.mdを再生成する。verifyはdocs一致、全コマンドの発見、引数例、JSON Schema、実CLIの出力と副作用も検査する。unitはMemory境界、実プロセス・FSの確認はscripts内のintegration verifierで行う。実Slack・Codex推論をテスト中に呼ばない。公開APIの破壊的変更ではREADME、同梱CLI skill、packageの型も更新する。

通常のCLIはstdinを読まず期限付き。人の明示したforegroundだけ期限の例外とする。資格情報はクリップボードからだけ登録し、CLIは端末入力を一切読まない。結果のrequestIdをdaemonとイベントへ渡し、ログ保存失敗もstatusへ出す。停止を確認できない再起動はuncertainとして二重起動しない。

障害時は元の原因と後片付けの失敗を併記し、causesに安全なコード・スタックを残す。イベントDB障害は制限付きメモリ履歴とテキストログで継続し、健全性を偽らない。プロセスの終了を確認できないときは所有情報を捨てて重ねて起動しない。検証script自体も型検査する。

未処理例外の自動復旧はCLI所有プロセスだけ。60秒内3回の上限をjournalへ保存し、呼び出し元のアプリは勝手に再起動しない。古いworkerの更新は操作IDを照合し、制御リクエストでは起動識別情報の変化を拒否する。
