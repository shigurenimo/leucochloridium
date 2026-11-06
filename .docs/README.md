# 開発ドキュメント

## 現行仕様

- [README](../README.md)：起動、Codexとの共有、Slack、Discord、予定、運用。
- [CLI.md](../CLI.md)：コマンドの引数、結果、副作用、再試行時の注意。
- [同梱スキル](../skills/leuco-cli/SKILL.md)：AIがCLIで調査・操作する手順。
- [AGENTS.md](../AGENTS.md)：コードの構造、境界、不変条件、検証。
- [SECURITY.md](../SECURITY.md)：資格情報とアクセス権限の境界。

受信判定は `lib/connectors/slack/accepts-slack-event.ts` と `lib/connectors/discord/accepts-discord-event.ts` がイベントを受付種別へ写し、共通の `lib/connectors/accepts-reception.ts` がモデル呼び出し前に判定する。設定項目とCLI例はREADMEを参照。`scripts/verify-discord-proxy.ts` は実CLI・daemon・Memory境界での検証で、実Discordでの認証・投稿の成功とは区別する。

## 障害調査

[障害調査と復旧](reliability.md) からstatus・doctor・履歴の確認へ進む。内部の判断条件は [障害時の設計詳細](reliability-design.md)、回帰テストと検証の範囲は [検証の記録](reliability-verification.md) を参照する。検証の記録はリポジトリだけに置き、npmの配布物には含めない。

## 過去の記録

過去の変更は [CHANGELOG](../CHANGELOG.md) を参照する。現在の使い方は上記の現行仕様に従う。
