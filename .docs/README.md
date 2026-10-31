# 開発ドキュメント

## 現行仕様

- [README](../README.md)：起動、Codexとの共有、Slack、予定、運用。
- [CLI.md](../CLI.md)：コマンドの引数、結果、副作用、再試行時の注意。
- [同梱スキル](../skills/leuco-cli/SKILL.md)：AIがCLIで調査・操作する手順。
- [CLAUDE.md](../CLAUDE.md)：コードの構造、境界、不変条件、検証。
- [SECURITY.md](../SECURITY.md)：資格情報とアクセス権限の境界。

CLI仕様の正本は `lib/cli/command-catalog.ts`。helpとCLI.mdは同じ定義から生成する。変更後は `bun run docs:cli`、検証は `bun run verify` を使う。実Slackへの投稿やCodex推論は検証に使わない。

## 障害調査

[障害調査と復旧](reliability.md) からstatus・doctor・履歴の確認へ進む。内部の判断条件は [障害時の設計詳細](reliability-design.md)、回帰テストと過去の実機確認は [検証の記録](reliability-verification.md) を参照する。

## 過去の記録

過去の変更は [CHANGELOG](../CHANGELOG.md) を参照する。現在の使い方は上記の現行仕様に従う。

Slackの受信ルールは `slackReception`。DM・メンション・参加済みスレッドを初期値で許可し、通常投稿・リアクション起動は明示指定する。`accepts-slack-event.ts` がモデル呼び出し前にチャンネル・ユーザー制限と種類を判定する。詳細とCLI例はREADMEを参照。外部APIによる軽量判定・自動リアクションは未実装（TypeSafe AIのJevを調査済み、Discordを先行）。

Discordは `discord login/logout/call`、`discordReception` と `discord.messageContent` で設定。Gatewayはflume、RESTは固定ホストへのfetch。`scripts/verify-discord-proxy.ts` が実CLI・daemon・Memory境界で受信判定と返信、資格情報の起動時取得・非露出を検証する。実Discord認証・投稿の成功とは区別する。
