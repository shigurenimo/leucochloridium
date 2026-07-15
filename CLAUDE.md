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
      ├─ Codex thread × 1
      └─ ChannelPlugin × N
         ├─ slack
         └─ schedule
```

- `Project` が設定と実行の唯一のユーザー向け単位。有効なproject一つから
  `LeucoTenant` 一つとCodex子プロセス一つを作る。
- project内のすべてのSlack接続、Slack会話、Slack thread、scheduleは
  一つの `codexThreadId` を共有する。pluginが渡す `threadKey` はplugin内の
  bookkeeping用で、tenantはCodex routingに使わない。
- `Channel` はSlack上のconversationではなく、project配下の接続plugin設定。
  Slack conversation IDは受信eventの `channel` 属性に乗る。
- 現行schemaにLeuco独自の `Agent` entityや `agents` 配列はない。
  `TenantAgentSpec`、`perAgentInstructions`、ログ中のagentはCodex実行主体を指す
  旧命名であり、新しいdomain entityを示さない。
- `project-store.ts` の `agents[]` はversion 1設定をversion 2のprojectへ
  flattenする移行専用。複数の旧agentは複数projectへ分割される。
- `.codex/agents/` はCodex subagent、macOS `LaunchAgent` はdaemon自動起動、
  `leuco projects <p> path agents` は `AGENTS.md` のpath。いずれも現行Leucoの
  Agent entityではない。

## スタック

Bun 1.3以上、TypeScript、ESM。HTTPはHonoで、CLIもargvを同じHono appへ
POSTする。wire値はZodでparseし、型は `z.infer` から作る。

Slack受信は `@interactive-inc/flume` のSocket Mode source、送信はraw `fetch`。
`@slack/bolt` と `@slack/web-api` には依存しない。MCPは
`@modelcontextprotocol/sdk`。Codex `app-server` はstdio JSON-RPCでspawnし、
Leuco MCPはdaemon内のstreamable HTTPで公開する。

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
├─ config/                  Project、Channel、Schedule、MCPのZod schema
├─ global-settings/         機械全体設定のstoreとschema
├─ projects/                registry、runtime state、scaffolder、旧設定移行
├─ daemon/                  一マシン一daemonのpid・log・spawn supervisor
├─ boot/                    macOS LaunchAgent
├─ events/                  typed event busとSQLite sink
├─ gateway/                 IPC・status・thread・MCP用HTTP gateway
├─ mcp/                     project scopeのMCP serverとtool schemas
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
  → project共通のturn queue
  → LeucoCodexClient
  → codex app-server
```

CodexがSlackへ返信する経路は次のとおり。

```text
codex child
  → http://127.0.0.1:<port>/mcp/<project-id>
  → slack_call MCP tool
  → LeucoFetchSlackWebClient
  → Slack Web API
```

`runTextTurn` のassistant textは内部出力で、pluginはそれを直接Slackへpostしない。
可視の返信はCodexが `slack_call` を呼ぶことで行う。

scheduleも `ChannelPluginContext.runTextTurn` へ合流し、同じ共通threadを使う。
`LeucoEventBus` は並行して `events.db` へ `slack.event`、`slack.connection`、
`slack.error`、`turn.start`、`turn.complete`、`turn.error`、`schedule.fired`、
`codex.notification` などを書く。

## 合成rootとライフサイクル

`LeucoRuntime.build({ env })` が唯一のwiring point。

- `~/.leuco/settings.json` の `projects` を `LeucoProjectStore` で読む
- enabled projectごとにenabled channelだけをplugin化する
- projectごとに独立 `CODEX_HOME` とCodex子プロセスを作る
- projectごとにdaemon起動中だけ有効なbearer tokenを発行する
- `LeucoEngine` がtenantのstart、stop、SIGHUP reconcileを所有する
- Hono gatewayがIPCと `/mcp/:projectId` を一つのportで受ける

project設定のsignatureにpath、prompt、model、MCP、enabled channel、Slack tokenを
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
その下の `settings.json` や `state.json` には置かない。それらのpathは旧version移行用。

各projectの `.codex/` はconfigとCodex memoryを分離する。`auth.json` だけは
`~/.codex/auth.json` へsymlinkし、ログインを共有する。regular fileがある場合は
そのprojectの意図的な別ログインとみなして上書きしない。

`events.db`はSlack本文を含むため本体、WAL、SHMを0600へ寄せる。
tenantの `config.toml` もMCP設定を含むため0600。

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
- project一つのturn queueは直列。一turnのwall-clock timeoutは10分で、
  timeoutまたはcommand output上限超過時はCodex子を再起動する。
- tenantの `config.toml` は `approval_policy = "never"` と
  `sandbox_mode = "danger-full-access"` を強制する。daemonには承認promptに
  答えるterminalがなく、macOS seatbeltのnetwork制限が無音で失敗するため。
- MCP bearer tokenはdaemon起動ごと・projectごとに発行し、
  `LEUCO_MCP_TOKEN` で該当Codex子だけへ渡す。project Aのtokenでproject Bの
  `/mcp/<id>` は呼べない。
- Slack pluginはstart時に `auth.test` でbot user IDを確定する。失敗または
  user ID欠落はfail-fastし、全messageを無音でdropする状態を許容しない。
- reaction eventはtelemetryにだけ流し、Codex turnを起動しない。
  bot自身のack reactionでloopしないため。
- Slack token変更後はtenant再構築が必要。schedule entry変更はpluginが
  再読み込みするため再構築不要。
- `LEUCO_CWD` はenv schemaに残るが現行runtimeのcwd overrideに使われていない。
  cwd変更は `leuco projects <p> cwd <path>` を使う。
- `runtime.ts`、`channel-host.ts`、`cli-env-schema.ts`の一部commentに旧pathや
  旧MCP URLの説明が残る。ドメインschema、`LeucoPaths`、実行コードを正とする。
