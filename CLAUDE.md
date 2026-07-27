# CLAUDE.md

`leuco` は Codex `app-server` を Slack Bot として動かすセルフホスト型gateway。
一マシン一daemonが全projectをsuperviseし、daemon、CLI、libraryは
`lib/runtime/runtime.ts` の `LeucoRuntime` を合成rootとする。

ユーザー向けの導入・Slack設定・運用は `README.md`。このファイルはAIが
現行コードを誤読しないための開発者向け地図に徹する。

## 現行ドメインモデル

```text
Leuco daemon
└─ Project
   └─ LeucoTenant
      ├─ Codex app-server child × 1
      ├─ Codex thread × 1..N
      └─ ChannelPlugin × N
         ├─ slack
         └─ schedule
```

- `Project` が設定と実行の唯一のユーザー向け単位。有効なproject一つから
  `LeucoTenant` 一つとCodex子プロセス一つを作る。
- `conversationScope: project` が既定で、project内のSlackとscheduleは一つの
  `codexThreadId` と直列queueを共有する。`thread` ではpluginが渡す
  `threadKey` ごとにCodex threadと直列queueを分け、異なるkeyは上限付きで並行する。
- `Channel` はSlack上のconversationではなく、project配下の接続plugin設定。
  Slack conversation IDは受信eventの `channel` 属性に乗る。
- 現行schemaにLeuco独自の `Agent` entityや `agents` 配列はない。
  `TenantAgentSpec`、`perAgentInstructions`、ログ中のagentはCodex実行主体を指す
  旧命名であり、新しいdomain entityを示さない。
- `.codex/agents/` はCodex subagent、macOS `LaunchAgent` はdaemon自動起動、
  `leuco projects <p> path agents` は `AGENTS.md` のpath。いずれも現行Leucoの
  Agent entityではない。

## スタック

Bun 1.3以上、TypeScript、ESM。HTTPはHonoで、CLIもargvを同じHono appへ
POSTする。wire値はZodでparseし、型は `z.infer` から作る。

Slack受信は `@interactive-inc/flume` のSocket Mode source、送信はraw `fetch`。
`@slack/bolt` と `@slack/web-api` には依存しない。Codex `app-server` は
stdio JSON-RPCでspawnする。Leuco内蔵MCPはなく、Slackとscheduleの操作は
project scope付きのローカル `leuco` CLIへ一本化する。project設定の
`mcpServers` は利用者がCodexへ追加する外部stdio MCPだけを表す。

event logは `@interactive-inc/claude-funnel` の `FunnelLogSqliteSink`。toolchainは
vite-plus、Vitest、TypeScript compiler、Bun test。

## ディレクトリ

```text
lib/
├─ index.ts                 CLI entry、env読み込み、cwd短縮、Hono dispatch
├─ api.ts                   packageのpublic export
├─ runtime/runtime.ts       唯一の合成root
├─ cli/                     Hono routesとargv parser
├─ engine/                  Engine、Tenant、ChannelPlugin、Codex client
├─ channels/                channel host、Slack plugin、schedule plugin
├─ actions/slack/           Slack API、file、DM診断
├─ config/                  Project、Channel、Schedule、外部MCPのZod schema
├─ global-settings/         機械全体設定のstoreとschema
├─ projects/                registry、runtime state、scaffolder
├─ daemon/                  一マシン一daemonのpid・log・spawn supervisor
├─ boot/                    macOS LaunchAgent
├─ events/                  typed event busとSQLite sink
├─ gateway/                 IPC・status・thread用loopback HTTP gateway
├─ fs/                      atomic writeとfile lock
├─ paths/leuco-paths.ts     `~/.leuco/` pathの唯一の組み立て元
└─ env/                     CLI env schemaとdotenv reader
```

## リクエストの流れ

Slack受信は次の経路。

```text
Flume Socket Mode source
  → LeucoSlackChannelPlugin
  → LeucoSlackEventProcessor
  → LeucoTenant.runTextTurn
  → conversation scopeに対応するturn queue
  → LeucoCodexClient
  → codex app-server
```

CodexがSlackへ返信する経路は次のとおり。

```text
codex child
  → LEUCO_PROJECT_IDで固定されたlocal leuco CLI
  → leuco slack call
  → slackCall action
  → LeucoFetchSlackWebClient
  → Slack Web API
```

可視の返信はCodexが `leuco slack call` を実行する経路を優先する。明示的な
postがなく、
宛先付きturnがfinal textを返した場合だけ、Slack pluginが同じthreadへその本文を
そのままfallback postする。失敗時の定型文は合成しない。

scheduleも `ChannelPluginContext.runTextTurn` へ合流する。project scopeでは共通thread、
thread scopeではschedule entryの `threadKey` に対応するthreadを使う。
`LeucoEventBus` は並行して `events.db` へ `slack.event`、`slack.connection`、
`slack.error`、`turn.start`、`turn.complete`、`turn.error`、`schedule.fired`、
`codex.notification` などを書く。

## 合成rootとライフサイクル

`LeucoRuntime.build({ env })` が唯一のwiring point。

- `~/.leuco/settings.json` の `projects` を `LeucoProjectStore` で読む
- enabled projectごとにenabled channelだけをplugin化する
- projectごとに独立 `CODEX_HOME` とCodex子プロセスを作る
- Codex子へそのprojectの `LEUCO_PROJECT_ID` を渡す
- `LeucoEngine` がtenantのstart、stop、SIGHUP reconcileを所有する
- Hono gatewayがhealth、status、thread制御をloopback portで受ける

project設定のsignatureにpath、prompt、model、外部MCP、enabled channel、Slack tokenを
含め、reconcileで変化を検出したtenantだけを再構築する。schedule entryは
pluginがtickごとに再読み込みするためsignatureから除外する。

## 保存と書き込み

`~/.leuco/settings.json` は機械全体で一つのJSONで、次を保存する。

- scalar global settings
- projectsの構成
- channelごとのSlack token
- projectごとの `codexThreadId`
- scheduleごとの `scheduleLastFiredAt`

Slack tokenを含むためmodeは0600。CLIとdaemonが同じファイルを
read-modify-writeするため、project変更は必ず `updateProject()` を使う。
`updateProject()` は `withFileLock` 内でfresh load、transform、atomic saveする。
古いsnapshotを `save()` で書き戻すと、daemonが書いたtenant stateを巻き戻す。

projectごとのruntime directoryは `~/.leuco/projects/<id>/`。現行の永続設定は
その下の `settings.json` や `state.json` には置かず、現行コードも読み込まない。

各projectの `.codex/` はconfigとCodex memoryを分離する。`auth.json` だけは
`~/.codex/auth.json` へsymlinkし、ログインを共有する。regular fileがある場合は
そのprojectの意図的な別ログインとみなして上書きしない。

`events.db`はSlack本文を含むため本体、WAL、SHMを0600へ寄せる。
tenantの `config.toml` は利用者設定の外部MCP環境変数を含み得るため0600。

## CLI route

argvを `lib/cli/utils/to-request.ts` がURLとbodyへ変換し、`lib/cli/routes/` の
Hono handlerへPOSTする。flagは `--key value` と `--key=value` を受ける。

ドット区切りのファイル名がURL segmentに対応する。

```text
projects.$project.channels.$channel.start.ts
  → POST /projects/:project/channels/:channel/start
```

新しいrouteを追加するときは次を行う。

- `lib/cli/routes/<name>.ts` に `<name>Handler` をexportする
- 隣に `<name>.help.ts` を置き、handler先頭でhelp flagを返す
- `lib/cli/routes/index.ts` に登録する
- 新しいleafを `to-request.ts` の対応setへ追加する
- 必要なgroup helpを更新する
- route、argv parse、helpのtestを追加する

help textはplain ASCII、2space indent、隣のhelpと同じ書式にする。

引数なしの `leuco` はdaemon停止中ならbackground start、起動済みなら
status表示。登録済みprojectのpathとcwdが完全一致する場合だけ
`leuco channels ...` を `leuco projects <p> channels ...` へ展開する。
Codex子では `LEUCO_PROJECT_ID` に対応するprojectをcwdより優先し、cwd変更後も
同じ短縮形をそのprojectへ展開する。projectを解決するCLI routeは明示された
project IDがscopeと一致しなければ403で拒否する。Codex子からこの環境変数を
解除・上書きしてはならない。

`.env.local` と `.env` を読むのはforegroundの `leuco run` だけ。その他のCLIや
`leuco start` で読むと、呼び出しcwdの無関係なsecretをdaemonへ固定するため
意図的に無視している。

## portsとテスト

IO境界はportを通し、テストでNode実装を直接使わない。新規実装の詳細は
`.claude/rules/ts.md` のabstract class、Node実装、Memory実装のルールを従う。

現行の主な境界は次のとおり。

- `CodexClientPort` と `LeucoCodexClient`
- `LeucoSlackWebClient` とFetch・Memory実装
- `LeucoSlackEventSource` とFlume・Memory実装
- `ChannelPlugin` とSlack・Schedule実装
- `LaunchctlPort` とプロセス実装

IOの重いclassは、event正規化を `Processor`、wire framingを `Protocol`、
Hono app組み立てをpure factoryへ分離する。testはsourceの隣の `.test.ts`、
Bun専用testは `.bun-test.ts` とする。

## 開発コマンド

```bash
bun install
bun run lib/index.ts -h
bun run lib/index.ts run
```

formatterとlinterは次。`vp check` にtypecheckとtestは含まれない。

```bash
vp check
```

typecheckとtestは個別に実行する。

```bash
bunx tsc -b
vp test run
bun test ./lib/events/leuco-event-bus.bun-test.ts
```

完全検査は次。

```bash
vp check && \
  bunx tsc -b && \
  vp test run && \
  bun test ./lib/events/leuco-event-bus.bun-test.ts
```

## 規約

`.claude/rules/` がsource of truth。ここに規約を複製しない。コードやMarkdownを
書く前に対応するruleを必ず読む。

- TypeScriptは `.claude/rules/ts.md`
- Reactが対象なら `.claude/rules/ts.react.md`
- Markdownは `.claude/rules/md.md`
- commitは `.claude/rules/git.md`
- software skill選択は `.claude/rules/software-skills.md`

## ハマりどころ

- Codex `app-server` は `initialize` requestと `initialized` notificationが必須。
  initializeは30秒でtimeoutし、失敗時は子プロセスを破棄する。
- CodexのJSON-RPC errorが `jsonrpc` fieldを欠くことがある。
  `lib/engine/codex/codex-protocol.ts` のwire扱いを参照する。
- `codex.stop()` はSIGTERM後5秒待ち、終了しなければSIGKILLへ昇格する。
  ストリームturnのaborterも必ずsettleさせる。
- project scopeではproject一つのturn queueを直列化する。thread scopeでは
  `threadKey` ごとに直列化し、異なるkeyを設定上限まで並行する。一turnの
  wall-clock timeoutは10分で、timeoutまたはcommand output上限超過時は
  Codex子を再起動する。
- tenantの `config.toml` は `approval_policy = "never"` と
  `sandbox_mode = "danger-full-access"` を強制する。daemonには承認promptに
  答えるterminalがなく、macOS seatbeltのnetwork制限が無音で失敗するため。
- Codex子へは `LEUCO_PROJECT_ID` を注入する。`leuco channels ...` と
  `--project` を省いた `leuco slack ...` はそのprojectを使い、別projectを
  明示した操作は拒否する。これは誤操作防止であり、shellから環境変数を
  意図的に解除できないsecurity sandboxではないため、built-in promptでも
  解除・上書きを禁止する。
- Slack pluginはstart時に `auth.test` でbot user IDを確定する。失敗または
  user ID欠落はfail-fastし、全messageを無音でdropする状態を許容しない。
- reaction eventはtelemetryにだけ流し、Codex turnを起動しない。
  bot自身のack reactionでloopしないため。
- Slack token変更後はtenant再構築が必要。schedule entry変更はpluginが
  再読み込みするため再構築不要。
- `LEUCO_CWD` はenv schemaに残るが現行runtimeのcwd overrideに使われていない。
  cwd変更は `leuco projects <p> cwd <path>` を使う。
