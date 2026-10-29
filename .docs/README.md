# 開発メモ

現行仕様は [README](../README.md)、開発者向けの配線と不変条件は [CLAUDE.md](../CLAUDE.md) を正本とする。

`notes/` は過去の設計記録。0.18でproject管理と専用CODEX_HOMEを廃止したため、それ以前のproject / gateway / prompt presetの記述は現行仕様ではない。

Slack資格情報はOSストアで保管し、起動時だけ読み込む。設定には参照IDだけを残す。Slack APIはdaemonで実行し、ファイルIOは呼び出し元で行う。OSストアが利用不能なら平文保存へ切り替えず失敗する。

CLIの主な利用者はAI。引数・必須option・副作用・前提条件・結果・再試行の判断をcommand-catalog.tsへ集約し、help / CLI.mdを生成する。標準YAML / 任意JSONの構造化出力ではstdoutは成功、stderrは失敗を表す。未知の外部Slack API仕様や外部操作の成否は推測しない。

障害時の継続・停止・再送の境界と検証の対応は [障害時の設計と検証](reliability.md) を参照する。
