# Leuco

Leuco は、Codex `app-server` を Slack Bot として動かすセルフホスト型
gateway です。マシン上の一つの daemon が複数のプロジェクトを管理し、
プロジェクトごとに独立した Codex プロセスを起動します。

Leuco は Bun 専用です。

## まず理解すること

Leuco の現行モデルは次のとおりです。

```text
Leuco daemon
├─ project A
│  └─ tenant
│     ├─ Codex app-server × 1
│     ├─ 共有 Codex thread × 1
│     ├─ Slack 接続 plugin
│     └─ schedule plugin
└─ project B
   └─ tenant
      └─ Codex app-server × 1
```

- `project` は、Codex に作業させるリポジトリと実行設定の単位です。
- `tenant` は、有効な project から作られる内部実行単位です。
  ユーザーが tenant を直接追加することはありません。
- CLI の `channel` は Slack の `#general` ではなく、project に付ける
  「接続 plugin 設定」です。種類は `slack` と `schedule` です。
- Slack上のパブリックチャンネル、プライベートチャンネル、DM、threadは
  Slack側の会話です。Leuco に一つずつ登録するものではありません。
- 現行Leucoに、ユーザーが追加・削除する `agent` エンティティはありません。
  Codex subagent、macOS LaunchAgent、過去バージョンの `agents[]` はそれぞれ別物です。

一つの project 内では、すべての Slack 接続、Slack会話、Slack thread、
schedule が一つの Codex thread を共有します。会話履歴を分離したい場合は
project を分けてください。

## 必要なもの

- [Bun](https://bun.sh) 1.3 以上
- [Codex CLI](https://github.com/openai/codex)
- Slack workspace に App をインストールできる権限
- macOS のバックグラウンド自動起動を使う場合は `launchctl`

## インストール

```bash
bun i -g leuco
leuco --version
codex login
```

チェックアウトしたこのリポジトリから動かす場合は次を使います。

```bash
bun install
bun link
leuco --version
```

## Slack Bot を起動する

ここでは `xoxb-...` の Bot User OAuth Token を使う標準構成を説明します。

### Slack App を作る

[Slack Apps](https://api.slack.com/apps) を開き、`Create New App` から
`From scratch` を選びます。App 名と導入先 workspace を指定してください。

`OAuth & Permissions` の `Bot Token Scopes` に次を追加します。

- `app_mentions:read`
- `channels:history`
- `im:history`
- `chat:write`
- `reactions:write`

プライベートチャンネルの全メッセージも受け取る場合は、
`groups:history` も追加します。

権限の意味はSlack公式の
[`app_mentions:read`](https://docs.slack.dev/reference/scopes/app_mentions.read/)、
[`chat:write`](https://docs.slack.dev/reference/scopes/chat.write/)、
[`groups:history`](https://docs.slack.dev/reference/scopes/groups.history/)
も参照してください。

### Slack event を設定する

`Event Subscriptions` で `Enable Events` を有効にし、
`Subscribe to bot events` に次を追加します。

- `app_mention`
- `message.channels`
- `message.im`

プライベートチャンネルの全メッセージも必要な場合は `message.groups`、
複数人DMも必要な場合は `message.mpim` と `mpim:history` を追加します。
反応eventを観測する場合は `reaction_added` も追加できます。

### Socket Mode と App token を設定する

`Socket Mode` で `Enable Socket Mode` を有効にします。Slack の案内に従うか、
`Basic Information` の `App-Level Tokens` から `connections:write` scope 付きの
App-level token を作ります。発行された `xapp-...` を控えてください。

`connections:write` はSocket Mode接続を開くApp-level scopeです。詳細は
[Slack公式のscope説明](https://docs.slack.dev/reference/scopes/connections.write/)
を参照してください。

Socket Mode では公開HTTP endpointは不要です。詳細は
[Slack公式のSocket Modeガイド](https://docs.slack.dev/apis/events-api/using-socket-mode/)
を参照してください。

### Slack App をインストールする

`Install App` から workspace へインストールし、`Bot User OAuth Token` の
`xoxb-...` を控えます。scopeやeventを変更した後に再インストールを
求められた場合は必ず実行してください。

### project と Slack 接続を登録する

Bot に作業させたいリポジトリのrootで実行します。project 名は
デフォルトでディレクトリ名になります。

```bash
cd /path/to/your-repo
leuco projects add .
leuco channels add slack
```

`leuco channels ...` の短縮形は、登録済みリポジトリのrootでだけ使えます。
どこからでも実行したい場合は次の完全形を使います。

```bash
leuco projects <project-name> channels add slack
```

既に登録済みかは次で確認できます。

```bash
leuco projects
leuco channels
```

### Slack token を保存する

token を shell history やprocess listへ残さないため、標準入力を使います。

macOS では、まず `xoxb-...` をクリップボードへコピーして実行します。

```bash
pbpaste | leuco channels slack set-tokens --bot-token -
```

次に `xapp-...` をコピーして実行します。

```bash
pbpaste | leuco channels slack set-tokens --app-token -
```

`pbpaste` のない環境では次を一つずつ実行し、tokenを貼り付け、
Enter の後に `Ctrl-D` を入力します。

```bash
leuco channels slack set-tokens --bot-token -
```

```bash
leuco channels slack set-tokens --app-token -
```

`slack` はここでは Slack 接続の名前です。`channels add slack --name work`
のように別名で作った場合は、`slack` の代わりにその名前を使います。

保存結果を確認します。

```bash
leuco channels
```

次のように `tokensSet: true` なら準備完了です。

```yaml
channels:
  - name: slack
    type: slack
    enabled: true
    tokensSet: true
```

token は Slack 接続ごとに `~/.leuco/settings.json` へ保存されます。
Slack token用の実行時環境変数は不要です。

### foreground で起動する

初回はログをそのまま読める foreground で起動します。

```bash
leuco run
```

`ready` とSlack接続のログが表示されたら、Slack上の対象チャンネルへBotを
招待し、メンションします。

```text
/invite @Bot名
@Bot名 hello
```

DMを使う場合はSlack AppとのDMを開き、直接メッセージを送ります。

### バックグラウンド起動に切り替える

動作確認後は `Ctrl-C` で `leuco run` を停止し、次を実行します。

```bash
leuco start
leuco status
```

引数なしの `leuco` も、daemon停止中ならバックグラウン起動し、
起動済みならstatusを表示します。

macOSログイン時に自動起動するには次を実行します。

```bash
leuco boot install
leuco boot
```

## user token を使う場合

Leuco は `xoxp-...` のuser tokenも受け付けます。この場合、Botではなく
token所有ユーザーとしてSlack APIを実行します。

- User Token Scopesに `channels:history`、`im:history`、`im:read`、
  `chat:write` を設定します。
- `message.channels` と `message.im` をuser eventとして購読します。
- 必要に応じて `groups:history`、`mpim:history`、`message.groups`、
  `message.mpim` を追加します。
- Socket Mode用の `xapp-...` はBot token構成と同じく必要です。

CLI上は `xoxp-...` も互換性のため `--bot-token` に渡します。

```bash
pbpaste | leuco channels slack set-tokens --bot-token -
```

## 日常の操作

### daemon

```text
leuco                         停止中なら起動、起動済みならstatus表示
leuco run                     foreground実行
leuco start                   バックグラウン起動
leuco stop                    停止
leuco restart                 停止して起動
leuco kill                    daemonと残存Codexプロセスを停止
leuco status                  daemonとprojectの状態をYAML表示
leuco logs -f                 daemonログを追跡
leuco doctor                  設定・Codex・Slack・残存プロセスを診断
leuco update --check          新バージョンを確認
leuco update                  最新版へ更新
```

### project

```text
leuco projects                            登録済みproject一覧
leuco projects add [<path>]               既存リポジトリを登録
leuco projects create <path>              リポジトリの雛形を作成して登録
leuco projects <p> start                  projectを有効化
leuco projects <p> stop                   projectを無効化
leuco projects <p> restart                tenantを再構築
leuco projects <p> rename <new>           project名を変更
leuco projects <p> relocate <new-path>    リポジトリを移動してpathを更新
leuco projects <p> cwd <path>             ファイルを移動せずCodexのcwdだけ変更
leuco projects <p> session                共有Codex threadの状態表示
leuco projects <p> session reset          共有Codex threadを破棄して再起動
leuco projects <p> path [key]             project関連pathを表示
leuco projects <p> remove [--cascade]     登録解除
```

### 接続 plugin

```text
leuco projects <p> channels                         接続一覧
leuco projects <p> channels add slack               Slack接続を追加
leuco projects <p> channels add schedule            schedule接続を追加
leuco projects <p> channels <c> start               有効化
leuco projects <p> channels <c> stop                無効化
leuco projects <p> channels <c> restart             tenantを再構築
leuco projects <p> channels <c> rename <new>        接続名を変更
leuco projects <p> channels <c> set-tokens          Slack tokenを更新
leuco projects <p> channels <c> remove              接続を削除
```

登録済みリポジトリのrootでは `leuco projects <p>` を省略して
`leuco channels ...` と実行できます。

### schedule

```bash
leuco projects <p> channels <c> schedules list
leuco projects <p> channels <c> schedules add \
  --name one-shot-check \
  --run-at '2026-07-16T09:00:00+09:00' \
  --prompt '状態確認を実行してSlackへ報告して'
leuco projects <p> channels <c> schedules remove one-shot-check
```

`--run-at` は5field cron、またはISO 8601時刻を受け付けます。ISO 8601は
一度だけ実行し、実行後に削除されます。scheduleの変更は最大60秒以内に
読み込まれ、tenant再起動は不要です。

### Slack APIとfile

```bash
leuco slack call chat.postMessage \
  --project <p> \
  --body '{"channel":"C0123","text":"hello"}'

leuco projects <p> channels <c> download-file \
  --file F0123 \
  --out ./download.bin
```

Codex側には同等の操作がMCP toolとして公開されます。

## 動作の仕組み

```text
Slack Socket Mode
  → Slack接続plugin
  → event検証・dedup・self-bot除外
  → projectのtenant
  → project共通のCodex thread
  → Codexがslack_call MCP toolを呼ぶ
  → Slack Web API
```

- 有効なprojectごとに一つのCodex `app-server` がstdio JSON-RPCで起動します。
- すべての入力はproject共通のCodex threadへ直列化され、実行中に到着した
  複数メッセージは次のturnへbatchされます。
- Slackから届くメッセージは構造化された入力としてCodexへ渡ります。
  返信するかは組み込みpromptとCodexが判断します。
- Codexのturn戻り値は直接Slackへpostされません。表示する返信はCodexが
  `slack_call` MCP toolを呼ぶことで送信します。
- 一turnのwall-clock timeoutは10分です。timeoutしたCodex子プロセスは
  停止・再起動されます。
- projectごとの `CODEX_HOME` でconfigと記憶を分離します。Codexログインだけは
  `~/.codex/auth.json` のsymlinkで共有します。

## 保存先

```text
~/.leuco/
├─ settings.json
│  └─ 機械全体設定、projects、Slack token、Codex thread state
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

`settings.json`、`events.db`、各tenantの `config.toml` にはsecretやSlack本文が
含まれるため、Leucoはファイルmodeを0600へ制限します。

## 環境変数と機械設定

- `LEUCO_CODEX_BIN` はCodex実行ファイルのpathです。デフォルトは `codex` です。
- `LEUCO_PORT` はloopback MCP gatewayのportです。デフォルトは7331です。
- `.env.local` と `.env` は `leuco run` のときだけ実行cwdから読みます。
  それ以外のコマンドと `leuco start` はこれらを読みません。
- 既存のprocess環境変数は `.env.local` と `.env` より優先されます。
- `leuco config` は機械全体設定をYAML表示します。macOSではデフォルトで
  `keepAwake: true` となり、daemonと一緒に `caffeinate` が動きます。

```bash
leuco config
leuco config set keepAwake false
```

## 診断

まず次を実行してください。

```bash
leuco doctor
leuco status
leuco events --preset errors
leuco logs -f
```

### botToken is empty

Slack接続はありますが `xoxb-...` または `xoxp-...` が保存されていません。

```bash
leuco channels
pbpaste | leuco channels slack set-tokens --bot-token -
leuco channels
```

### appToken is empty

Slack接続はありますが `xapp-...` が保存されていません。

```bash
pbpaste | leuco channels slack set-tokens --app-token -
leuco channels
```

daemon起動中にtokenを変更した場合は接続を再起動します。

```bash
leuco channels slack restart
```

### auth.test が失敗する

- `--bot-token` に `xoxb-...` または `xoxp-...` を入れたか確認する
- Slack Appのscopeを変更した後にworkspaceへ再インストールしたか確認する
- tokenが別workspaceのものでないか確認する
- `leuco doctor` と `leuco logs -f` でSlack APIのエラーを確認する

### メンションに反応しない

- `app_mention` eventと `app_mentions:read` scopeを確認する
- Botを対象Slackチャンネルへ `/invite @Bot名` したか確認する
- `xapp-...` に `connections:write` があるか確認する
- Slack AppがSocket Modeで接続中か `leuco logs -f` で確認する
- プライベートチャンネルでは `groups:history` と `message.groups` を確認する

### DMに反応しない

- `message.im` eventと `im:history` scopeを確認する
- user tokenの場合、`message.im` をbot eventではなくuser eventへ追加する
- SlackのDM会話ID `D...` を使って配信経路を診断する

```bash
leuco slack dm D0123ABC --project <p>
```

`socket_event_missing` なら、Slack履歴にはメッセージがありますがSocket Modeで
Leucoへ届いていません。

## event log

Leucoは `~/.leuco/daemon/events.db` に構造化eventを保存します。

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

`leuco logs -f` はdaemonのテキストログ、`leuco events` はSQLiteの構造化eventを
読みます。

## ライブラリ利用

```ts
import { LeucoRuntime } from "leuco"

const runtime = LeucoRuntime.build({ env: process.env })
await runtime.start()
```

`LeucoRuntime`、`LeucoEngine`、`LeucoTenant`、`LeucoCodexClient`、
`LeucoSlackChannelPlugin`、`LeucoChannelHost`、`LeucoEventBus`、
`LeucoProjectStore` などはpackage rootからexportされます。Leuco自体が
Bun専用のため、非Bun runtimeからのimportはエラーになります。

## ライセンス

MIT
