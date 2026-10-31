# CLAUDE.md

Leucoは一匹のCodexを常駐させるBun専用CLI。使い方は [README.md](README.md)、コマンドは [CLI.md](CLI.md)、アクセス境界は [SECURITY.md](SECURITY.md)。

## 設計

`LeucoRuntime` が唯一の合成root。Codex app-server一つと直列queue一つを持ち、会話キーをCodex threadへ対応付ける。Slack接続一つとscheduleは任意の入力経路。projectや複数agentの管理を追加しない。

Codex子は親の環境変数を引き継ぐ。通常の `CODEX_HOME` を使い、設定・認証のコピーやsymlinkを作らない。追加指示は明示的に選択されたSOULだけ。権限・sandboxを上書きしない。

- `lib/cli/command-catalog.ts` がコマンド契約の正本。parser・validator・help・CLI.mdで共有する。
- `lib/runtime/` はqueue・会話・接続の合成、`lib/engine/` はCodex stdio JSON-RPC。
- `lib/connectors/` は内部のSlack・schedule入力、`lib/actions/slack/` はdaemon内のSlack API操作。ファイルの読み書きは呼び出し元CLIで行う。
- `lib/config/` は単一設定schema、`lib/storage/` は設定と状態、`lib/secrets/` はOS資格情報ストア。
- `lib/daemon/` はleaseと認証付きローカル制御、`lib/maintenance/` は再起動worker・操作journal・修復。
- `lib/events/` はLeucoの履歴とSQLite保守。`lib/event-log/` はFunnelとsource共有のため、変更時は両製品を同期する。Funnelのpackage依存はない。

## 不変条件

- 指示や実行contextが変わったら新しいthreadを使う。任意のresume失敗で会話対応表を消さない。
- 全入力を一つのqueueで直列実行し、停止時は待機依頼も完了させる。予定の受付は実行前に保存し、失敗した依頼を自動再実行しない。
- Slackのfinal answerは内部出力。本文送信は明示的な `leuco slack call`、ack reactionは別の設定で制御する。
- tokenはクリップボードからだけ登録し、OSストアへ保存する。設定には参照IDだけを残す。起動時に一度読み、Codex・journal・ログへ渡さない。平文fallbackなし。
- 設定・状態は0600、ホームは0700。更新はlock内のfresh loadとatomic writeで行う。`settings.json` は設定、`state.json` は会話対応表と予定実行時刻。
- 通常のCLIはstdinを読まず期限付き。明示されたforegroundだけ期限の例外。出力はwrite・flushを確認し、終了処理はCLI所有プロセスに閉じる。
- requestIdを制御要求とイベントへ渡す。背景ログに別の依頼のIDを付けない。公開出力をマスク・schema検証し、元の原因と後片付けの失敗を保持する。
- 履歴の保存失敗もstatusへ出す。DB障害は制限付きメモリ履歴とテキストログで継続し、健全性を偽らない。作成したログは作成元が閉じる。
- 所有解除はPID・token、worker更新は操作IDを照合する。確認できない停止や観測失敗を理由に所有情報を捨てたり重ねて起動したりしない。
- 未処理例外の自動復旧はCLI所有プロセスだけ。60秒内3回の上限をjournalへ保存し、ライブラリ利用者のアプリを再起動しない。

障害時の判断条件は [障害時の設計詳細](.docs/reliability-design.md)、調査手順は [障害調査と復旧](.docs/reliability.md) を参照する。

## 検証

本番ソース変更後は `bun run verify` を完了まで確認する。CLI定義変更後は `bun run docs:cli` で再生成する。公開APIの破壊的変更ではREADME・同梱CLI skill・packageの型も更新する。

unitはMemory境界を使う。実プロセス・FSは `scripts/` のintegration verifierで確認し、script自体も型検査する。実Slackへの投稿・Codex推論・実資格情報操作をテストに使わない。
