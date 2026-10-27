# CLAUDE.md

Leucoは一匹のCodexを常駐させるBun専用CLI。使い方は [README.md](README.md)、アクセス境界は [SECURITY.md](SECURITY.md)。

## 現行モデル

`LeucoRuntime` が唯一の合成root。Codex app-serverを一つ、直列queueを一つ持つ。会話キーごとにCodex threadを対応付ける。Slack接続一つとscheduleは任意の入力経路で、ユーザー向けproject / connector登録は廃止した。

Codex子は親の環境変数を引き継ぐ。`CODEX_HOME` を書き換えず、設定や認証のコピー・symlinkを作らない。標準では追加のdeveloper instructionsなし。選択されたSOULだけをCodex設定のdeveloper instructionsへ追加する。権限・sandboxの上書きは禁止。

## ソース

- `lib/cli/` は引数parse、flat command、設定とSlack操作。
- `lib/config/` はversion 4の単一設定schema。
- `lib/secrets/` はOS資格情報ストアのabstract / Bun / Memory実装。平文fallbackなし。
- `lib/storage/` は設定と状態のabstract store、Node / Memory実装。更新はlock内fresh loadとatomic write。
- `lib/daemon/` はlease、Unix socket、認証付きローカル制御、前面・背景起動。
- `lib/runtime/` は配線、直列queue、会話再開、SOUL、timeout、終了処理。
- `lib/engine/` はCodex stdio JSON-RPCとturnの収集。
- `lib/connectors/` は内部のSlack / schedule入力。複数agentの管理ではない。
- `lib/actions/slack/` はtokenを保持するdaemon内のSlack API操作。ファイルの読み書きは呼び出し元CLIで行う。
- `lib/events/` はLeucoイベントとSQLite保守。
- `lib/event-log/` はFunnelとsourceを共有する汎用event log。このディレクトリ変更時は両製品のsource同期が必要。LeucoにFunnelのpackage依存はない。
- `scripts/verify-single-companion.ts` は実CLIと偽Codexの統合検証。

## 不変条件

- `~/.codex` は通常のCodex資産。Leuco独自configを生成しない。
- 指示や実行contextが変わった場合は新しいthreadにし、古いSOULを再開しない。
- 失敗した依頼を自動で再実行しない。任意のresume失敗で対応表を消さない。
- 全入力は一つのqueueで直列実行する。停止時は待機依頼も完了させる。
- Slack final answerは内部出力。本文の送信は明示的な `leuco slack call`。ack reactionは独立した設定可能な動作。
- 設定には資格情報の参照IDだけを保存する。tokenはOSストアから起動時に一度だけ読み、Codexへ渡さない。設定と状態は0600、ホームは0700。
- `settings.json` は設定、`state.json` は会話対応表と予定実行時刻。古いsnapshotの上書きをしない。

## 検証

`bun run verify` を使う。unitはMemory境界、実プロセス・FSの確認はscripts内のintegration verifierで行う。実Slack・Codex推論をテスト中に呼ばない。公開APIの破壊的変更ではREADME、同梱CLI skill、packageの型も更新する。
