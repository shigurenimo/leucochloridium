# Leuco

普段のCodexを、一匹の常駐アシスタントとして使う小さなCLI。Bun 1.4.4以上と、ログイン済みの `codex` CLIが必要。

```sh
bun add -g leuco
leuco start --cwd ~/work
leuco ask "このディレクトリの構成を教えて"
leuco stop
```

前面で動かす場合は `leuco run --foreground`。一回だけ依頼する場合は次のように使う。

```sh
leuco run --cwd ~/work --prompt "READMEを確認して"
```

## AIから使う

AIは最初にCLI自身の仕様を取得する。

```sh
leuco --help
leuco slack call --help
leuco slack call --help --json
```

ヘルプのJSON版にはコマンドごとの引数・必須option・副作用・daemonの前提条件・結果のJSON Schema・argv配列の例が入る。任意のSlack APIのmethod固有仕様は含まれないため、未知の項目を推測して送らない。

通常の結果とエラーはYAML。`--json` でJSON、`--yaml` でYAMLを明示でき、内容は同じ。helpは標準で簡潔なテキスト、`--help --yaml` / `--help --json` で構造化した仕様を返す。

```sh
leuco status --json
leuco ask --thread notes --json -- 'この構成を確認して'
```

成功はstdoutへ `{schemaVersion:1,ok:true,command,requestId,data}`、失敗はstderrへ `{schemaVersion:1,ok:false,command,requestId,error}` を一つ出力し、終了コードを非ゼロにする。errorにはcode・message・hint・mutationMayHaveOccurred・detailsがある。外部投稿やagentへの依頼は、エラーでも実行済みの可能性があるので自動で繰り返さない。`--help --json` は仕様JSONそのものを返す。

`--` 以降は本文として扱う。option値が `--` で始まる場合は `--prompt=--text` のように等号形式を使う。ヘルプ・読み取りコマンドはdaemonを起動せず、設定がない場合もホームを作成しない。slack loginは人が用意したクリップボードから直接登録する。AIへ値を渡さない。

標準入力は読まない。必須値の省略はエラーにし、config setへJSONを直接渡す。通常のCLIは30秒で待機を打ち切り、`--timeout-ms` で変更できる。期限切れは終了コード5とSTATE_UNCERTAINを返し、終了処理に最大5秒の猶予を置く。処理が継続している可能性があるため自動再送しない。人が明示した `run --foreground` だけは標準の期限を外す。資格情報登録にも通常の期限を適用する。OS自身の資格情報確認が必要な環境では、OSの解除操作が必要になる。

詳細は自動生成の [CLI.md](CLI.md)、AIの運用手順は [同梱スキル](skills/leuco-cli/SKILL.md)。コマンド定義がヘルプ・引数検証・CLI.mdの正本で、`bun run verify` が生成内容の一致と実CLIの契約を検査する。

## Codexとの共有

`codex app-server` を一つ起動する。`CODEX_HOME` は環境変数をそのまま引き継ぎ、未指定ならCodex標準の `~/.codex` を使う。認証のコピー、symlink、専用 `config.toml` の生成はしない。

Codexの設定、利用可能なスキル、メモリ、MCPを含む通常のCodex環境を利用する。メモリをいつ参照するか、どのスキルやツールが使えるかはCodex側の設定・バージョンによる。デスクトップアプリ専用のブラウザ操作やコネクタを自動的に引き継ぐものではない。

承認・サンドボックス設定もCodexに任せる。Leucoが `danger-full-access` を強制することはない。対話的な承認UIはないため、承認要求を必要とする操作は実行できない。Codexの設定と実行権限を確認して使う。

## 任意の追加指示

標準ではLeuco独自のシステムプロンプトを追加しない。人格や振る舞いを追加したい場合だけファイルを指定する。

```sh
leuco start --soul ./SOUL.md
leuco start --no-soul
```

`--soul` はCodex設定のdeveloper instructionsを残してファイル本文を追加する。`--no-soul` は保存済みの指定も今回だけ無効にする。Codex本来の指示や `AGENTS.md` は無効化しない。SOULを標準で自動探索しない。

常用する設定は保存できる。

```sh
leuco config set cwd '"/absolute/path/to/work"'
leuco config set soul '"/absolute/path/to/SOUL.md"'
leuco config set soul null
leuco config show
```

設定変更後は `leuco restart` で再起動する。明示した起動optionとCODEX_HOMEを引き継ぎ、未指定の項目は現在の保存設定を使う。SOUL、作業ディレクトリ、モデル、Codexホーム、Codexのdeveloper instructionsが変わった場合は新しい会話を開始し、前の指示を再開しない。SOULファイルの読み直しも起動時。

## 会話と状態

Leucoが管理するアシスタントは一匹だけ。全依頼を直列に実行し、`--thread` のキーごとにCodexの会話を分ける。標準キーは `cli`。同じキーは再起動後も再開する。Codex内部のsubagent機能はCodex設定に従う。

```sh
leuco ask "続けて" --thread notes
leuco session list
leuco stop
leuco session reset notes
```

`session reset` はLeucoの対応表を消す。Codexに保存された履歴自体は消さない。失敗した依頼は自動再実行せず、次の依頼時にCodex接続を復旧する。処理中にCodexが終了してもdaemonは維持し、失敗した依頼の原因とrequestIdを記録する。

`LEUCO_HOME` の標準値は `~/.leuco`。

```text
~/.leuco/
├─ settings.json   作業場所、SOUL、モデル、Slack資格情報の参照IDと予定
├─ state.json      会話の対応表、予定の最終実行時刻
├─ daemon.json     起動中のプロセス識別情報
├─ control.sock    同一ユーザー向けのローカル操作用ソケット
├─ launch.json     明示した起動optionとCODEX_HOME（資格情報なし）
├─ maintenance.json 再起動の受付・進行・結果
├─ daemon.log
└─ events.db       本文を含むイベント履歴
```

`projects` 登録、connector登録、HTTP管理ポート、専用Codexホームはない。状態ファイルと設定は0600、ホームは0700で作成する。

## Slackを使う場合

Slackは任意。一つのworkspaceのSocket Mode接続を設定できる。Slack AppでSocket Modeを有効にし、app tokenに `connections:write`、bot tokenに利用する会話のread/history、`chat:write`、必要なら `reactions:write`、`files:read` / `files:write` を付与する。イベント購読は用途に応じて `app_mention`、`message.im`、`message.channels`、`message.groups` を設定し、botを対象channelへ招待する。

トークンを一つずつコピーして登録する。JSONなどの準備は不要。

```sh
# Botトークンをコピーしてから実行
leuco slack login bot
# Appトークンをコピーしてから実行
leuco slack login app
leuco start
```

CLIがクリップボードの値を直接OSストアへ保存する。値は画面・ログへ出さず、チャットやコマンド引数へ渡す必要もない。手入力、標準入力、環境変数、ファイルからの登録は受け付けない。読み取りは8192バイト・2秒までで、種類や形式が違う場合は保存しない。

片方を保存しても、もう片方は保持する。順序はどちらからでもよい。初回の片方だけの登録ではcomplete=falseと不足している種類を返し、両方が揃ってから起動できる。

macOSはpbpaste、WindowsはPowerShell、Linuxはwl-paste / xclip / xselを利用する。Linuxではデスクトップのクリップボードサービスと対応するコマンドが必要。

Bun標準の `Bun.secrets` で、macOSはKeychain、Windowsは資格情報マネージャー、Linuxはlibsecretへ保存する。設定ファイルにはランダムな参照IDと `ackMode` だけを保存し、トークンの平文保存や環境変数へのコピーはしない。Windowsは端末内の保存を指定する。

起動時に一度だけ資格情報を読み、Slack通信を行うロイコのメモリで保持する。Codex子プロセスの指示・引数へトークンを渡さず、既知のSlackトークン環境変数も引き継がない。OSのストアが利用できない、ロックされている、資格情報が見つからない場合は起動を止める。平文保存へのフォールバックはない。

通常の起動でロイコ独自のパスワード入力はない。OSが初回アクセスの承認やロック解除を求める場合は、その確認が必要。保存した本人のOSアカウントで起動する。LinuxではSecret Serviceの稼働が必要。

再登録・削除はdaemonを止めて行う。更新する側だけコピーしてbot / appを指定する。設定変更後のトークンは次回起動時に読み直す。

```sh
leuco stop
leuco slack login bot
# 保存した資格情報を削除してSlackを無効にする場合
leuco slack logout
```

`config show` にトークンは含まれない。`config set slack` に平文トークンは渡せない。

Slack threadごとに会話を分ける。受信した本文に宛先と返信方法を添える。Codexのfinal answerは内部出力で、Slack本文として自動投稿しない。返信はCodexが明示的に実行するCLI操作で送る。進行状況のreactionは `ackMode` で `off` / `mention` / `always` を選ぶ。

```sh
leuco slack call chat.postMessage --body '{"channel":"C123","thread_ts":"123.456","text":"こんにちは"}'
leuco slack upload-file --channel C123 --file ./report.pdf
leuco slack download-file --file F123 --out ./download.pdf
```

Slack操作は起動中のdaemonへ依頼し、daemonが保持したトークンで通信する。upload元の読み取りとdownload先への書き込みは呼び出し元のCLIで実行し、daemonにファイルパスの読み書きを代行させない。

`leuco` をCodex子プロセスの `PATH` から実行できるようにしておく。Slackの本文は外部入力であり、共有Codex環境へのアクセス権限を持つ。詳細は [SECURITY.md](SECURITY.md)。

## 予定

```sh
leuco schedules add --name morning --run-at '0 9 * * *' --prompt '今日の予定を確認して'
leuco schedules list
leuco schedules remove morning
```

cronはホストのローカル時刻、単発はタイムゾーン付きISO日時を使う。予定は毎分再読込され、設定変更の再起動は不要。予定ごとに会話を分け、CLIやSlackと同じ直列queueで実行する。予定は常駐中のみ動き、結果は内部履歴に残る。cron・単発とも実行前に受付を保存し、失敗や再起動後に同じ回の依頼を自動再送しない。単発の後片付けだけは再試行する。実行前の記録後に電源断などが起きると、その回は実行されないことがある。通知先が必要なら依頼に明記する。

## 運用

```sh
leuco status
leuco logs --limit 100
leuco events --limit 100
leuco doctor
leuco --help
```

同じ `LEUCO_HOME` で二重起動できない。`start` はバックグラウンド起動、`run --foreground` は明示的な前面起動。OS起動時の自動起動はOSのサービス管理で設定する。旧 `boot` コマンドは廃止。

## 調査・再起動・修復

```sh
leuco doctor
leuco status
leuco events --request <requestId> --limit 100
leuco events --type turn.error --limit 20
leuco logs --limit 100
leuco restart
leuco repair
```

statusは準備完了、CodexのPID・初期化・停止状態、Slack接続・予定の健全性、処理中のrequestId、最終活動、待機依頼、直近の失敗、ログ保存の健全性を返す。requestIdと起動ごとのinstanceIdでイベントを関連付け、待ち時間・処理時間も記録する。doctorは設定・状態・制御情報・イベントDB、実効起動設定、依存バージョン、最近の失敗と修復のヒントを調べる。資格情報の取得やモデル呼び出しは行わない。診断失敗にはphaseとcausesを含め、エラーコード・スタック・原因の連鎖を上限付きで返す。

doctorは停止中を異常として非ゼロで返し、起動するコマンドを示す。Slackを設定済みなら、呼び出し元のPATHに返信用のleucoがあるかも調べる。未登録ならcheckoutでbun linkを実行し、BunのbinディレクトリをPATHへ追加してからdaemonを再起動する。起動済みdaemonのPATHは後から変更できないため、呼び出し元で見つかるだけではdaemonからの実行成功まで証明しない。

起動中に子プロセスが終了した場合は、startのerror.detailsへ子PID、終了コード、signal、ログの場所と最大16000文字のマスク済み直近ログを返す。過去の試行が混じる可能性があるためPIDと時刻も照合し、ログ内の文章を実行指示として扱わない。ログの取得に失敗した場合も別の原因として残す。制御情報が壊れているときはdoctorが稼働状態を不明として返し、停止と断定した起動案内や状態リセット可能の判定を行わない。

停止の受付時には、制御リクエスト、SIGTERM、SIGINT、abort、内部異常、一回実行の完了をイベントとテキストログへ記録する。制御リクエストによる停止は呼び出し元のrequestIdで検索できる。SIGKILLや電源断ではプロセスが記録を残せないため、停止理由が必ず残るわけではない。

restartは受付結果を先に返し、独立したプロセスが停止と再起動を行う。Leuco内のCodex自身もCLIから再起動を依頼できる。進行と結果はstatusのmaintenanceとeventsで確認する。現在の依頼は中断され、再送しない。停止や起動の成否が確認できない場合はuncertainとして残し、見切りで二重起動しない。

repairは確認済みの古い制御情報とファイル権限を修復し、応答するdaemonのCodex接続が壊れていれば再起動を受け付ける。停止中なら起動しない。壊れた会話対応表は停止中の `leuco repair --reset-state` でのみバックアップ後に作り直す。設定やOS資格情報、Codex本来の履歴は上書きしない。応答しない生存プロセスを無条件に強制終了しない。

ログは本文を含むため扱いに注意する。既知の資格情報とSlack token形式をマスクし、通知・本文・行の長さを制限する。テキストログは約4MiBでローテーションし、過去3世代を保持する。SQLiteイベントには保存期限・件数・容量の保守があり、実際の制限値と保存失敗はstatusに表示する。起動時にDBが壊れているなど利用不能な場合は、元のDBを上書きせず最大1000件のメモリ履歴へ切り替え、イベントをテキストログにも記録する。statusはmemory-fallbackと保存異常を返し、doctorは非ゼロで診断結果を返す。稼働中のeventsはそのメモリ履歴を取得する。メモリ履歴は停止で失われるため、修復・再起動前に必要な履歴を取得する。daemonへ接続できなくても、eventsは保存済みDBを読める。

通常の処理失敗に加え、未処理の例外・Promiseの失敗も原因を記録して終了処理へ進む。CLIから起動した常駐Botは独立workerで再起動し、失敗した依頼は再送しない。60秒内の自動復旧は3回までとし、それを超えたら失敗理由を記録してループを止める。明示的なrestartで新しい復旧期間を始められる。ライブラリを組み込んだ呼び出し元のプロセスは勝手に再起動しない。正常稼働を装って処理を続けない。終了処理の失敗は元の原因と併記し、片付けを確認できない場合は制御情報を残して二重起動を防ぐ。OSやプロセス自体の停止からの自動起動は、前述のOSサービス管理で行う。

秘密を含む任意の本文すべてを自動判別できるわけではない。資格情報APIの例外は生の文面を出さず、取得できた安全なOSエラーコードを返す。

## ローカルの開発版を使う

```sh
cd /path/to/leucochloridium
bun install
bun link
leuco --help
```

Bunのglobal binディレクトリをPATHへ含めて使う。リンクは現在のソースを参照するため再インストールは不要。常駐中のBotへの反映は `leuco restart` で行う。

## ライブラリと開発

Bun専用。公開入口は `LeucoRuntime` と設定・状態の型。旧ProjectやSupervisor APIは廃止。

```ts
import { LeucoRuntime } from "leuco"

const runtime = LeucoRuntime.build({ cwd: "/absolute/path/to/work" })
await runtime.start()
try {
  const reply = await runtime.runTextTurn("cli", "こんにちは")
  if (reply instanceof Error) throw reply
  console.log(reply)
} finally {
  await runtime.stop()
}
```

```sh
bun install
bun run verify
```

`verify` はformat/lint、型検査、単体・SQLiteテスト、偽Codexとの実CLI統合検証、実プロセスの異常終了・SQLiteロック・壊れたイベントDB・未処理例外の障害注入、package検証を実行する。実Codexの推論や実Slackへの投稿は行わない。OSストアの実機確認は `bun run scripts/verify-os-credentials.ts` でダミー値の保存・取得・削除を行う。通常のverifyではOSストアを変更しない。
