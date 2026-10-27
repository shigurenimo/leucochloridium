# 開発メモ

現行仕様は [README](../README.md)、開発者向けの配線と不変条件は [CLAUDE.md](../CLAUDE.md) を正本とする。

`notes/` は過去の設計記録。0.18でproject管理と専用CODEX_HOMEを廃止したため、それ以前のproject / gateway / prompt presetの記述は現行仕様ではない。

Slack資格情報はOSストアで保管し、起動時だけ読み込む。設定には参照IDだけを残す。Slack APIはdaemonで実行し、ファイルIOは呼び出し元で行う。OSストアが利用不能なら平文保存へ切り替えず失敗する。
