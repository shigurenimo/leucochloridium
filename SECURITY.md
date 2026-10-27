# セキュリティ

Leucoは信頼できる本人が動かすローカルCLI。独立した隔離環境ではない。

## 権限

Codexの通常の `CODEX_HOME` を共有する。Codexの認証、メモリ、スキル、MCP設定がそのまま使われ得る。LeucoはCodexのsandboxやapproval policyを上書きしない。対話的な承認要求には対応せず、未対応のserver requestをエラーで拒否する。

Leuco独自の読み書き可能ディレクトリ制限やCLI allowlistは実装していない。CLIの名前を制限してもshell経由の迂回を防げない。必要な制限はCodexのsandbox設定、OS権限、またはコンテナなどの実行環境で用意する。

## ローカル管理

制御用Unix socketはLeucoホーム内に作り、ランダムtokenによる認証を行う。ホームは0700、socket、設定、状態、イベントDBは0600。TCP管理ポートは開かない。同じOSユーザーで動く他のプロセスからの分離は保証しない。

`settings.json` にはSlack資格情報の参照IDだけを保存する。bot / app tokenはBun.secrets経由でOSの資格情報ストアへ保存する。macOSはKeychain、Windowsは資格情報マネージャーの端末内保存、Linuxはlibsecretを使う。平文保存へフォールバックしない。登録は `slack login` の非表示入力で行い、コマンド引数やpipeによるトークン登録を受け付けない。

起動時に読み取り、daemonだけがSlack通信に使う。Codexへトークンを指示・コマンド引数で渡さず、既知のSlackトークン環境変数は子プロセスから除外する。Slack操作CLIは認証付きのローカル制御経由で依頼する。ファイルの読み書きは呼び出し元で行い、daemonにはuploadのバイト列を渡し、downloadのバイト列を受け取る。

既知のトークン値はロイコのログとイベント履歴、Slack APIのJSON応答から伏せる。終了時にロイコが持つ参照を解放するが、JavaScript文字列の完全な消去は保証できない。

OSストアは保存時の保護であり、同じOSユーザーで任意のコードを実行できるCodexからの完全な隔離ではない。同じユーザーや管理者から秘密を隔離するには別の権限分離が必要。OSがアクセス承認やストアのロック解除を要求する場合がある。利用不能時は起動を止める。

## 外部入力と出力

Slack本文とschedule promptはCodexへの入力になる。Slackの利用範囲は信頼できる相手に限定する。本文のenvelope escapeは、prompt injectionに対する完全な防御ではない。外部入力からCodexのファイル・コマンド・MCP権限へ到達し得る。

Codexのfinal answerはSlackへ自動投稿しない。本文の送信は明示的なCLI操作で行う。設定に応じたack reactionは自動実行する。この境界はCodex自身が危険な操作を選ばないことを保証するものではない。

Slack private file取得では認証付きの通信先を検証する。外部upload URLへはSlack bearer tokenを付けない。uploadは100 MiBまで。

## 保存

`daemon.log` と `events.db` は受信本文、依頼、応答、コマンドの出力を含み得る。Codex自身の会話履歴も通常のCodexホームに残る。Leucoのsession resetはCodex履歴を削除しない。

Codexデスクトップ専用のブラウザ操作は追加していないが、それだけで安全とはみなさない。既存のMCPやCLIが持つネットワーク・ブラウザ能力はCodexの設定に従う。

## 報告

問題はGitHubのprivate vulnerability reportingが利用可能ならそこへ報告し、利用できない場合は秘密情報を含めずmaintainerへ連絡する。公開Issueにtokenや本文ログを載せない。
