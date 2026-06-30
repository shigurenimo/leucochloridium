# CLAUDE.md

`leuco` は Codex `app-server` を Slack bot 化する自ホスト型のマルチテナント gateway。1 マシン 1 daemon が、登録された project を全て supervise する。1 project = 1 tenant = 1 codex プロセス。daemon、CLI、ライブラリは全て `lib/runtime/runtime.ts` の `LeucoRuntime` を合成ルートに持つ。

ユーザー向けの利用フローは README.md。本ファイルは AI が最短でコードを読み進めるための地図に徹する。

## スタック

Bun >= 1.3 / TypeScript / ESM。HTTP は Hono（CLI も argv → POST に変換して同じ Hono に流す）。バリデーションは Zod で、wire 型は全て `z.infer`。Slack は受信が `@interactive-inc/flume` の Socket Mode source、送信が raw `fetch`（`@slack/bolt` と `@slack/web-api` には依存しない）。MCP は `@modelcontextprotocol/sdk`（codex が stdio で spawn）。ツールチェインは vite-plus + vitest。

## ディレクトリ

```
lib/
├── index.ts              CLI entry。`--version` も
├── api.ts                ライブラリ公開面
├── cli/                  Hono ルート（routes/）と argv パーサ（utils/to-request.ts）
├── runtime/runtime.ts    合成ルート: projects → tenants → engine
├── engine/               LeucoEngine、LeucoTenant、ChannelPlugin port、codex/
├── channels/             channel-host + slack/（adapter / event-source / web-client / processor / xoxp-poller）+ schedule/
├── actions/slack/        CLI から呼ぶ Slack アクション（slack-call / download-file）
├── config/               projects/channels の zod schemas
├── projects/             プロジェクトレジストリ + scaffolder
├── daemon/leuco-daemon.ts  pid/log/spawn supervisor（1 マシン 1 daemon）
├── events/               typed event bus (FunnelLogSqliteSink → events.db)
├── gateway/              IPC 用 HTTP gateway + `/mcp/:project` streamable HTTP MCP
├── mcp/build-mcp-server  Server 組み立て（HTTP MCP の本体。stdio fallback は廃止）
├── paths/leuco-paths.ts  ~/.leuco/* のパスは全てここ。inline 禁止
└── env/                  zod 型付き env loader
```

## リクエストの流れ

Slack envelope → `LeucoFlumeSlackEventSource`（flume の Socket Mode をラップ）→ `slack-channel-plugin` → `slack-event-processor`（schema 検証 / dedup / self-bot フィルタ）→ `LeucoTenant` → `LeucoCodexClient`（codex stdio、JSON-RPC）→ tool 呼び出しは codex が daemon の `/mcp/:project` を streamable HTTP で叩く → 返信は agent が `slack_call` MCP tool 経由で `LeucoFetchSlackWebClient` を叩いて post する。並行して `LeucoEventBus` が SQLite（`events.db`）に書く（`slack.event` / `slack.connection` / `slack.error` / `turn.*` / `schedule.fired` など）。MCP は 1 daemon = 1 gateway = N テナントを path で振り分ける構成で、bearer token を daemon 起動毎に発行し、各 codex 子の `LEUCO_MCP_TOKEN` env に注入する。

## 合成ルート

`LeucoRuntime.build({ env })` が唯一の wiring 点。`~/.leuco/settings.json` の `projects` 配列を `LeucoProjectStore` で読み、無効な channel を除外し、有効な project ごとに `LeucoTenant` を作る。テナントは固有の `CODEX_HOME`（`~/.leuco/projects/<id>/.codex/`）を持ち、`LeucoChannelHost` から channel plugins を組み立て、`LeucoEventBus` に ack/onLog を bind する。最後に `LeucoEngine` が reconcile / start / stop を所有。`leuco run` / `leuco start` のどちらも `LeucoRuntime.build(...).start()` の薄いラッパ。

## CLI ルート

argv → URL/body 変換は `lib/cli/utils/to-request.ts`、各サブコマンドは `lib/cli/routes/` の `POST /<segments>`。flag は `--key value` と `--key=value` 形式どちらも受ける。素の `leuco` は `/` に解決され、daemon が居なければ `leuco start` 相当として daemon を起動する。

ファイル名はドット区切りで URL を表現する。

```
projects.$project.channels.$channel.start.ts
  → POST /projects/:project/channels/:channel/start
```

ルート追加手順。

- `lib/cli/routes/<name>.ts` で `<name>Handler` を export
- 隣に `<name>.help.ts` を置き、ハンドラ冒頭で `if (flagBool(body.flags.help)) return c.text(help)`
- `lib/cli/routes/index.ts` に登録
- 新しいトップレベル動詞なら `to-request.ts` の `TOP_LEAFS` と `group.help.ts` も更新

help テキストは plain ASCII、2 スペースインデント。隣の help を見て揃える。

## ports とテスト

IO 境界は port 型を持ち、IO の重い class は純粋 inner class を切り出してモック可能にする。例として `CodexClientPort` ↔ `LeucoCodexClient`、`LeucoSlackWebClient`（abstract）↔ `LeucoFetchSlackWebClient`（Node）/`LeucoMemorySlackWebClient`（test）、`LeucoSlackEventSource`（abstract）↔ `LeucoFlumeSlackEventSource`（Node）/`LeucoMemorySlackEventSource`（test）、`LeucoChannelHost` はテストで fake を注入できる。テストは `*.test.ts` でソースの隣。

```
vp test run        単発テスト
vp check           fmt + lint + typecheck + test
tsc -b             typecheck のみ
bun run dev        lib/index.ts をフォアグラウンド実行
```

## 規約

`.claude/rules/*.md` が source of truth（`ts.md` / `ts.react.md` / `git.md` / `md.md` / `software-skills.md`）。要約をここに書かない。古くなって嘘になる。コードを書き始める前に必ず該当ファイルを読む。

## ハマりどころ

Codex `app-server` は JSON-RPC `initialize` ハンドシェイクが必須。エラー応答が `jsonrpc` フィールドを欠くケースがある（`lib/engine/codex/codex-protocol.ts`）。

`codex.stop()` は SIGTERM 後 5 秒待って exit しなければ SIGKILL に昇格する。子が SIGTERM を握り潰しても tenant restart がハングしない（`lib/engine/codex/codex-client.ts`）。

`~/.leuco/settings.json` は Slack トークンを含む projects 配列を持つので chmod 600。`LeucoProjectStore` と `LeucoGlobalSettingsStore` が書き込み時にモードを強制する。

各テナントの `CODEX_HOME` は `~/.codex/auth.json` を symlink して codex ログインを共有しつつ、メモリは独立させている。

MCP bearer token は daemon 起動毎に新規生成されるため、`leuco restart` 直後はテナントの codex 子も再 spawn されないと古い token を持ったままになる。token をローテートしたら codex 側も restart させる。

tenant の `CODEX_HOME/config.toml` は `approval_policy = "never"` + `sandbox_mode = "danger-full-access"` を強制する。daemon にターミナルが無く承認 prompt に答えられないこと、`workspace-write` の network 制限が macOS seatbelt で silently 効くケース（git push / 外部 API / npm install で EPERM）を踏むことが理由。`runTextTurn` は 10 分の wall-clock timeout を持ち、超えたら codex 子を restart する（`lib/engine/tenant.ts`）。

Slack channel plugin は起動時に `auth.test` を呼んで bot user id を確定する。`auth.test` 失敗や user id 欠落時は **fail-fast で plugin start を throw する**（黙って全 message を「botUserId unknown」として捨てない）。reconcile はその tenant を上げ直す経路に流す。
