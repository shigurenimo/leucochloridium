# CLAUDE.md

`leuco` は Codex `app-server` を Slack Bot として動かすセルフホスト型gateway。
一マシン一daemonが全projectを監督し、daemon、CLI、libraryは
`lib/runtime/runtime.ts` の `LeucoRuntime` を合成rootとする。

ユーザー向けの導入・Slack設定・運用は `README.md`。このファイルはAIが
現行コードを誤読しないための開発者向け地図に徹する。

## 現行ドメインモデル

```text
Leuco daemon
├─ LeucoProjectSupervisor
└─ ProjectSlot × N
   └─ LeucoProjectRuntime
      ├─ Codex app-server child × 1
      ├─ ProjectThreadRegistry
      ├─ ProjectTurnQueue
      └─ Connector × N
         ├─ slack
         └─ schedule
```

- `Project` が設定と実行の唯一のユーザー向け単位。有効なproject一つから
  `LeucoProjectRuntime` 一つとCodex子プロセス一つを作る。
- `conversationScope: project` が既定で、project内のSlackとscheduleは一つの
  Codex threadと直列queueを共有する。`thread` ではconnectorが渡す
  `threadKey` ごとにthreadと直列queueを分け、異なるkeyは上限付きで並行する。
- `Connector` はprojectに接続する統合機能。現行型は `slack` と `schedule`。
  Slackのchannel、DM、threadは登録対象ではなく、受信eventの `channel` 属性に乗る。
- 現行schemaにLeuco独自の `Agent` entityや `agents` 配列はない。
  `.codex/agents/` はCodex subagent、macOS `LaunchAgent` はdaemon自動起動、
  `leuco projects <p> path agents` は `AGENTS.md` のpathを指す。

## スタック

Bun 1.3以上、TypeScript、ESM。GatewayはHono、CLIはprocess内専用の
`CliRouter`。CLI argvをURLやHTTP requestへ変換せず、command pathとbodyへparseして
直接dispatchする。wire値はZodでparseし、型は `z.infer` から作る。

Slack受信は `@interactive-inc/flume` のSocket Mode source、送信はraw `fetch`。
`@slack/bolt` と `@slack/web-api` には依存しない。Codex `app-server` は
stdio JSON-RPCでspawnする。Leuco内蔵MCPはなく、追加のSlack操作とschedule、
file操作はproject scope付きのローカル `leuco` CLIへ一本化する。project設定の
`mcpServers` は利用者がCodexへ追加する外部stdio MCPだけを表す。

汎用event logは `lib/event-log/` に置く。Funnelにも同じsourceをコピーして
各libraryが所有し、LeucoからFunnelへの製品依存は持たない。Funnel側の旧logger名は
compatibility wrapperとして残す。コピー元を変更するときは両directoryを同期し、
`diff -ru` で一致を確認する。

## ディレクトリ

```text
lib/
├─ index.ts                 CLI entry、env読み込み、cwd短縮、in-process dispatch
├─ api.ts                   安定したpackage root export
├─ runtime/runtime.ts       唯一の合成root
├─ project/                 runtime、supervisor、thread registry、turn queue
├─ connectors/              connector host、Slack、schedule
├─ control/                 loopback daemon control clientとcontract
├─ cli/                     command router、route、argv parser
├─ actions/slack/           Slack API、file、DM診断
├─ config/                  Project、Connector、Schedule、外部MCPのZod schema
├─ projects/                project設定store、runtime state、legacy state migration
├─ global-settings/         機械全体のscalar設定
├─ engine/                  Codex clientとturn timeout
├─ daemon/                  pid、log、background process lifecycle
├─ boot/                    macOS LaunchAgent
├─ event-log/               汎用event log、memory store、SQLite store
├─ events/                  Leuco event schema、query、保守
├─ gateway/                 health、status、thread、control用loopback HTTP
├─ fs/                      atomic writeとfile lock
├─ paths/leuco-paths.ts     `~/.leuco/` pathの唯一の組み立て元
└─ env/                     CLI env schemaとdotenv reader
```

## リクエストの流れ

Slack受信から通常返信までの経路。

```text
Flume Socket Mode source
  → SlackConnector
  → SlackEventProcessor
  → LeucoProjectRuntime.runTextTurn
  → conversation scopeに対応するProjectTurnQueue
  → LeucoCodexClient
  → codex app-server
  → non-empty final answer
  → SlackAdapter
  → 同じSlack thread
```

通常のfinal answerはLeucoが一度だけ直接投稿する。`leuco slack call` は
追加メッセージ、reaction、fileなど、Codexが明示的に要求した追加副作用だけに使う。
失敗時の定型文は合成しない。

scheduleも `ConnectorContext.runTextTurn` へ合流する。project scopeでは共通thread、
thread scopeではschedule entryの `threadKey` に対応するthreadを使う。
`LeucoEventLog` は並行して `events.db` へSlack、turn、schedule、
Codex notification、runtime、supervisor eventを書く。

## 合成rootとライフサイクル

`LeucoRuntime.build({ env })` が唯一のwiring point。

- `~/.leuco/settings.json` のprojectsとglobal settingsを読む
- projectごとのstateを `~/.leuco/projects/<id>/state.json` から読む
- enabled projectから `LeucoProjectRuntime` をbuildする
- enabled connectorだけをruntimeへ組み込む
- projectごとに独立した `CODEX_HOME` とCodex子プロセスを作る
- Codex子へprojectの `LEUCO_PROJECT_ID` を渡す
- `LeucoProjectSupervisor` がproject slot、retry、pause、reconcileを所有する
- Hono gatewayがhealth、status、thread、daemon controlをloopback portで受ける
- `LeucoRuntime` がsupervisor、gateway、`eventLog` を兄弟として所有する

`ProjectSlot` はruntime、config signature、retry、pauseを一つのMap entryで所有する。
reconcileはpath、prompt、model、外部MCP、enabled connector、Slack tokenの変化を
signatureで検出し、変わったprojectだけを再構築する。schedule entryはconnectorが
tickごとに再読み込みするためsignatureから除外する。connector restartは
project全体を再構築せず、対象connectorだけをstop、startする。

CLIが設定を変更するときは、必要な範囲だけdaemon control APIでprojectをpauseし、
atomicな設定変更後にresumeまたはreconcileする。projectの `enabled` は永続設定であり、
一時停止の代用品にしない。

## 保存と書き込み

`~/.leuco/settings.json` は人が管理する永続設定だけを保存する。

- scalar global settings
- projectの構成
- connectorの構成とSlack token
- prompt、model、外部MCP設定

`~/.leuco/projects/<id>/state.json` は実行時stateだけを保存する。

- project scopeのCodex thread ID
- thread scopeのCodex thread ID map
- scheduleごとの最終発火時刻

schema version 3がcanonicalで、project fieldは `connectors`。version 2の
`channels` とsettings内のruntime stateはread boundaryで移行し、次の管理操作で
canonical形式を保存する。compatibility fieldを現行domain modelへ持ち込まない。

Slack tokenを含むsettingsは0600。CLIとdaemonが同じファイルを
read-modify-writeするため、project変更は必ず `updateProject()` を使う。
`updateProject()` は `withFileLock` 内でfresh load、transform、atomic saveする。
古いsnapshotを `save()` で書き戻してはならない。state更新は
`LeucoProjectStateStore` に限定する。

各projectの `.codex/` はconfigとCodex memoryを分離する。`auth.json` だけは
`~/.codex/auth.json` へsymlinkし、ログインを共有する。regular fileがある場合は
そのprojectの意図的な別ログインとみなして上書きしない。

`events.db` はSlack本文を含むため本体、WAL、SHMを0600へ寄せる。
projectの `config.toml` は外部MCP環境変数を含み得るため0600。

## CLI route

`lib/cli/utils/parse-cli-invocation.ts` がargvをcommand pathとJSON bodyへ変換し、
`CliRouter.dispatch()` が `lib/cli/routes/` のhandlerをprocess内で直接呼ぶ。
実network、URL、`Request`、`fetch` は経由しない。flagは `--key value` と
`--key=value` を受ける。

ドット区切りのファイル名がcommand segmentに対応する。

```text
projects.$project.connectors.$connector.start.ts
  → /projects/:project/connectors/:connector/start
```

新しいrouteを追加するときは次を行う。

- `lib/cli/routes/<name>.ts` にhandlerをexportする
- 必要なら隣にhelp routeを置く
- `lib/cli/routes/index.ts` に `.command()` で登録する
- parserのleafやflag規則を更新する
- group help、route、argv parseのtestを追加する

help textはplain ASCII、2space indent、隣のhelpと同じ書式にする。

引数なしの `leuco` はdaemon停止中ならbackground start、起動済みならstatus表示。
登録済みprojectのpathとcwdが完全一致する場合だけ `leuco connectors ...` を
`leuco projects <p> connectors ...` へ展開する。Codex子では
`LEUCO_PROJECT_ID` に対応するprojectをcwdより優先し、cwd変更後も同じ短縮形を
固定projectへ展開する。projectを解決するrouteは明示されたproject IDがscopeと
一致しなければ403で拒否する。

`.env.local` と `.env` を読むのはforegroundの `leuco run` だけ。その他のCLIや
`leuco start` では、呼び出しcwdの無関係なsecretをdaemonへ固定しないため読まない。

## 公開API

package rootは安定した最小面だけを公開する。

- `LeucoRuntime`
- Project、Connector、Schedule、外部MCPのcontract
- EventLog、store contract、memory実装、SQLite実装

daemon、gateway、CLI、store、具体connector、test fakeはinternal。新しいexportは
既存consumerへ長期互換性を約束できる場合だけ追加する。

## portsとテスト

IO境界はportを通し、テストで実networkや実child processへ依存しない。
新規実装の詳細は `.claude/rules/ts.md` のabstract class、Node実装、
Memory実装のルールに従う。

現行の主な境界は次のとおり。

- `CodexClientPort` と `LeucoCodexClient`
- `LeucoSlackWebClient` とFetch、Memory実装
- `LeucoSlackEventSource` とFlume、Memory実装
- `Connector` とSlack、Schedule実装
- `LaunchctlPort` とprocess実装
- `EventLogStore`、`EventLogRelay` とMemory、SQLite実装
- `DaemonControl` と `DaemonControlClient`

IOの重いclassはevent正規化をprocessor、wire framingをprotocol、
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
bun test ./lib/events/leuco-event-log.bun-test.ts
```

完全検査は次。

```bash
bun run verify
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
  stream turnのaborterも必ずsettleさせる。
- project scopeではproject一つのturn queueを直列化する。thread scopeでは
  `threadKey` ごとに直列化し、異なるkeyを設定上限まで並行する。
- wall-clock timeout、idle timeout、command output上限超過、Codex process exitは
  そのprojectのCodex子だけを置き換える。失敗turnは副作用重複を避けるためreplayしない。
- projectの `config.toml` は `approval_policy = "never"` と
  `sandbox_mode = "danger-full-access"` を強制する。daemonには承認promptへ
  答えるterminalがなく、macOS seatbeltのnetwork制限が無音で失敗するため。
- Codex子へは `LEUCO_PROJECT_ID` を注入する。`leuco connectors ...` と
  `--project` を省いた `leuco slack ...` はそのprojectを使い、別projectを
  明示した操作は拒否する。
- Slack connectorはstart時に `auth.test` でbot user IDを確定する。
  失敗またはuser ID欠落はfail-fastする。
- reaction eventはtelemetryにだけ流し、Codex turnを起動しない。
- Slack token変更後は対象connectorのrestartでよい。project全体を再構築しない。
- `LEUCO_CWD` はenv schemaに残るがruntimeのcwd overrideには使わない。
  cwd変更は `leuco projects <p> cwd <path>` を使う。
