# Leuco

普段のCodexを、一匹の常駐アシスタントとして使う小さなCLI。Bun 1.4.4以上と、ログイン済みの `codex` CLIが必要。

```sh
bun add -g leuco
leuco start --cwd ~/work
leuco ask "このディレクトリの構成を教えて"
leuco stop
```

前面で動かす場合は `leuco run`。一回だけ依頼する場合は次のように使う。

```sh
leuco run --cwd ~/work --prompt "READMEを確認して"
```

## Codexとの共有

`codex app-server` を一つ起動する。`CODEX_HOME` は環境変数をそのまま引き継ぎ、未指定ならCodex標準の `~/.codex` を使う。認証のコピー、symlink、専用 `config.toml` の生成はしない。

Codexの設定、利用可能なスキル、メモリ、MCPを含む通常のCodex環境を利用する。メモリをいつ参照するか、どのスキルやツールが使えるかはCodex側の設定・バージョンによる。デスクトップアプリ専用のブラウザ操作やコネクタを自動的に引き継ぐものではない。

承認・サンドボックス設定もCodexに任せる。Leucoが `danger-full-access` を強制することはない。対話的な承認UIはないため、承認要求を必要とする操作は実行できない。Codexの設定と実行権限を確認して使う。

## 任意の追加指示

標準ではLeuco独自のシステムプロンプトを追加しない。人格や振る舞いを追加したい場合だけファイルを指定する。

```sh
leuco start --soul ./SOUL.md
leuco start --no-soul
```

`--soul` はCodex設定のdeveloper instructionsを残してファイル本文を追加する。`--no-soul` は保存済みの指定も今回だけ無効にする。Codex本来の指示や `AGENTS.md` は無効化しない。SOULを標準で自動探索しない。

常用する設定は保存できる。

```sh
leuco config set cwd '"/absolute/path/to/work"'
leuco config set soul '"/absolute/path/to/SOUL.md"'
leuco config set soul null
leuco config show
```

設定変更後は `leuco stop` と `leuco start` で再起動する。SOUL、作業ディレクトリ、モデル、Codexホーム、Codexのdeveloper instructionsが変わった場合は新しい会話を開始し、前の指示を再開しない。SOULファイルの読み直しも起動時。

## 会話と状態

Leucoが管理するアシスタントは一匹だけ。全依頼を直列に実行し、`--thread` のキーごとにCodexの会話を分ける。標準キーは `cli`。同じキーは再起動後も再開する。Codex内部のsubagent機能はCodex設定に従う。

```sh
leuco ask "続けて" --thread notes
leuco session list
leuco stop
leuco session reset notes
```

`session reset` はLeucoの対応表を消す。Codexに保存された履歴自体は消さない。失敗した依頼は自動再実行せず、次の依頼時にCodex接続を復旧する。

`LEUCO_HOME` の標準値は `~/.leuco`。

```text
~/.leuco/
├─ settings.json   作業場所、SOUL、モデル、Slack資格情報の参照IDと予定
├─ state.json      会話の対応表、予定の最終実行時刻
├─ daemon.json     起動中のプロセス識別情報
├─ control.sock    同一ユーザー向けのローカル操作用ソケット
├─ daemon.log
└─ events.db       本文を含むイベント履歴
```

`projects` 登録、connector登録、HTTP管理ポート、専用Codexホームはない。状態ファイルと設定は0600、ホームは0700で作成する。

## Slackを使う場合

Slackは任意。一つのworkspaceのSocket Mode接続を設定できる。Slack AppでSocket Modeを有効にし、app tokenに `connections:write`、bot tokenに利用する会話のread/history、`chat:write`、必要なら `reactions:write`、`files:read` / `files:write` を付与する。イベント購読は用途に応じて `app_mention`、`message.im`、`message.channels`、`message.groups` を設定し、botを対象channelへ招待する。

初回は対話的な端末でトークンを登録する。入力内容は画面に表示しない。

```sh
leuco slack login
leuco start
```

Bun標準の `Bun.secrets` で、macOSはKeychain、Windowsは資格情報マネージャー、Linuxはlibsecretへ保存する。設定ファイルにはランダムな参照IDと `ackMode` だけを保存し、トークンの平文保存や環境変数へのコピーはしない。Windowsは端末内の保存を指定する。

起動時に一度だけ資格情報を読み、Slack通信を行うロイコのメモリで保持する。Codex子プロセスの指示・引数へトークンを渡さず、既知のSlackトークン環境変数も引き継がない。OSのストアが利用できない、ロックされている、資格情報が見つからない場合は起動を止める。平文保存へのフォールバックはない。

通常の起動でロイコ独自のパスワード入力はない。OSが初回アクセスの承認やロック解除を求める場合は、その確認が必要。保存した本人のOSアカウントで起動する。LinuxではSecret Serviceの稼働が必要。

再登録・削除はdaemonを止めて行う。設定変更後のトークンは次回起動時に読み直す。

```sh
leuco stop
leuco slack login
# 保存した資格情報を削除してSlackを無効にする場合
leuco slack logout
```

`config show` にトークンは含まれない。`config set slack` に平文トークンは渡せない。

Slack threadごとに会話を分ける。受信した本文に宛先と返信方法を添える。Codexのfinal answerは内部出力で、Slack本文として自動投稿しない。返信はCodexが明示的に実行するCLI操作で送る。進行状況のreactionは `ackMode` で `off` / `mention` / `always` を選ぶ。

```sh
leuco slack call chat.postMessage --body '{"channel":"C123","thread_ts":"123.456","text":"こんにちは"}'
leuco slack upload-file --channel C123 --file ./report.pdf
leuco slack download-file --file F123 --out ./download.pdf
```

Slack操作は起動中のdaemonへ依頼し、daemonが保持したトークンで通信する。upload元の読み取りとdownload先への書き込みは呼び出し元のCLIで実行し、daemonにファイルパスの読み書きを代行させない。

`leuco` をCodex子プロセスの `PATH` から実行できるようにしておく。Slackの本文は外部入力であり、共有Codex環境へのアクセス権限を持つ。詳細は [SECURITY.md](SECURITY.md)。

## 予定

```sh
leuco schedules add --name morning --run-at '0 9 * * *' --prompt '今日の予定を確認して'
leuco schedules list
leuco schedules remove morning
```

cronはホストのローカル時刻、単発はタイムゾーン付きISO日時を使う。予定は毎分再読込され、設定変更の再起動は不要。予定ごとに会話を分け、CLIやSlackと同じ直列queueで実行する。予定は常駐中のみ動き、結果は内部履歴に残る。通知先が必要なら依頼に明記する。

## 運用

```sh
leuco status
leuco logs --limit 100
leuco events --limit 100
leuco doctor
leuco --help
```

同じ `LEUCO_HOME` で二重起動できない。`start` はバックグラウンド起動、`run` は前面起動。OS起動時の自動起動はOSのサービス管理で設定する。旧 `boot` コマンドは廃止。

## ライブラリと開発

Bun専用。公開入口は `LeucoRuntime` と設定・状態の型。旧ProjectやSupervisor APIは廃止。

```ts
import { LeucoRuntime } from "leuco"

const runtime = LeucoRuntime.build({ cwd: "/absolute/path/to/work" })
await runtime.start()
try {
  const reply = await runtime.runTextTurn("cli", "こんにちは")
  if (reply instanceof Error) throw reply
  console.log(reply)
} finally {
  await runtime.stop()
}
```

```sh
bun install
bun run verify
```

`verify` はformat/lint、型検査、単体・SQLiteテスト、偽Codexとの実CLI統合検証、package検証を実行する。実Codexの推論や実Slackへの投稿は行わない。OSストアの実機確認は `bun run scripts/verify-os-credentials.ts` でダミー値の保存・取得・削除を行う。通常のverifyではOSストアを変更しない。
