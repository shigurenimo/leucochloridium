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
