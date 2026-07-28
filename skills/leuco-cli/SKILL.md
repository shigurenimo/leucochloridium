---
name: leuco-cli
description: leuco CLIでdaemon、project、connector、Slack操作を管理する。
---

# Leuco CLI

Leucoはprojectごとに一つのCodex `app-server`を動かすself-hosted gateway。
一マシン一daemonが登録済みprojectを監督し、Slackとscheduleをconnectorとして
project runtimeへ接続する。Slackのchannel、DM、threadはconnectorではなく会話。

## CLI

`leuco` commandは `PATH` 上にある。各groupの使い方は `-h` で確認する。

```text
leuco -h
leuco projects -h
leuco projects <p> connectors -h
```

最初に使うcommand。

- `leuco` はdaemon停止中なら起動し、起動済みならstatusを表示する
- `leuco status` はdaemonとprojectのhealthを表示する
- `leuco events` はstructured event journalを検索する
- `leuco projects` は登録済みprojectを表示する
- `leuco connectors` は現在のrepositoryに対応するconnectorを表示する

## 保存場所

全pathは `LeucoPaths` が組み立てる。手で連結しない。

```text
~/.leuco/
├─ settings.json
│  └─ global設定、project設定、connector設定、token
├─ daemon/
│  ├─ pid
│  ├─ log
│  └─ events.db
└─ projects/
   └─ <project-uuid>/
      ├─ state.json
      │  └─ Codex thread IDとschedule runtime state
      └─ .codex/
         └─ project専用CODEX_HOME
```

## Project runtime内での操作

Leucoが起動したCodex子には `LEUCO_PROJECT_ID` が設定される。このscopeでは
`leuco connectors ...` とproject指定なしの `leuco slack ...` が常に現在の
projectへ解決される。別projectを明示した操作は拒否される。

Leuco内蔵MCP serverはない。通常のnon-empty final answerはLeucoが発生元の
Slack threadへ直接一度だけ投稿する。`leuco slack call` は追加メッセージ、
reaction、fileなどの明示的な追加副作用にだけ使う。
