# Leuco

普段のCodexを、一匹の常駐アシスタントとして使う小さなCLI。Bun 1.4.4以上と、ログイン済みの `codex` CLIが必要。

CIはmacOS/Linuxを対象とする。Windows向けにはクリップボードと資格情報ストアの実装があるが、daemon全体のWindows実機動作は未検証。

起動する実行ファイルは`PATH`上の`codex`を使う。解決先は`leuco doctor`で確認できる。

```sh
bun add -g leuco
leuco start --cwd ~/work
leuco ask "このディレクトリの構成を教えて"
leuco stop
```

人が前面で動かす場合は `leuco run --foreground`。依頼は起動中の一匹へ`leuco ask`で送る。

## AIから使う

AIは最初にCLI自身の仕様を取得する。

```sh
leuco --help
leuco slack call --help
leuco slack call --help --json
```

ヘルプのJSON版にはコマンドごとの引数・必須option・副作用・daemonの前提条件・結果のJSON Schema・argv配列の例が入る。任意のSlack APIのmethod固有仕様は含まれないため、未知の項目を推測して送らない。

個別コマンドのヘルプは、その入力・結果に必要な型だけを含む。全仕様をまとめて取得する場合は`leuco --help --json`を使う。

通常の結果とエラーはYAML。`--json` でJSON、`--yaml` でYAMLを明示でき、内容は同じ。helpは標準で簡潔なテキスト、`--help --yaml` / `--help --json` で構造化した仕様を返す。

```sh
leuco status --json
leuco ask --thread notes --json -- 'この構成を確認して'
```

成功はstdoutへ `{schemaVersion:1,ok:true,command,requestId,data}`、失敗はstderrへ `{schemaVersion:1,ok:false,command,requestId,error}` を一つ出力し、終了コードを非ゼロにする。errorにはcode・message・hint・mutationMayHaveOccurred・detailsがある。外部投稿やagentへの依頼は、エラーでも実行済みの可能性があるので自動で繰り返さない。`--help --json` は仕様JSONそのものを返す。

Codex応答や通知の保持上限を超えた場合は、途中の本文を成功として返さず依頼を失敗させる。上限と診断コードは [Codexの通信と応答保持](.docs/reliability-design.md#codexの通信と応答保持) を参照する。

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

`--soul` はCodex設定のdeveloper instructionsを残してファイル本文を追加する。`--no-soul` は保存済みの指定も今回だけ無効にする。Codex本来の指示や `AGENTS.md` は無効化しない。SOULを標準で自動探索しない。SOULはUTF-8で保存し、不正な文字コードは起動時にエラーにする。

常用する設定は保存できる。

モデルは通常のCodex設定を使う。ロイコ専用の固定値が必要な場合は、保存設定の`model`へ集約する。CLIの起動オプションや`LeucoRuntime.build`にモデルの上書き指定はない。

```sh
leuco config set cwd '"/absolute/path/to/work"'
leuco config set soul '"/absolute/path/to/SOUL.md"'
leuco config set soul null
leuco config show
```

`config show` は既定値を補った保存設定を返す。起動時の上書きは含まれない。起動設定は `doctor`、現在の稼働状態は `status` で確認する。

設定変更後は `leuco restart` で再起動する。明示した起動optionとCODEX_HOMEを引き継ぎ、未指定の項目は現在の保存設定を使う。起動時に`--cwd`・`--soul`・`--no-soul`を指定していた場合、保存した作業場所やSOULへ切り替えるには`leuco stop`後、それらのflagを付けずに`leuco start`する。

SOUL、作業ディレクトリ、モデル、Codexホーム、Codexのdeveloper instructionsが変わった場合は新しい会話を開始し、前の指示を再開しない。SOULファイルの読み直しも起動時。Codex接続だけを復旧する場合はCodex側の追加指示を再確認し、変わっていれば新しい会話にする。SOULは起動時の内容を保つ。

## 会話と状態

`config`・`schedules`・`session`はコマンドグループ。実行時は`config show`・`schedules list`・`session list`まで明示する。グループの操作一覧は`leuco config --help`のように確認できる。

Leucoが管理するアシスタントは一匹だけ。全依頼を直列に実行し、`--thread` のキーごとにCodexの会話を分ける。標準キーは `cli`。同じキーは再起動後も再開する。Codex内部のsubagent機能はCodex設定に従う。

```sh
leuco ask "続けて" --thread notes
leuco session list
leuco stop
leuco session reset notes
```

`session reset` はLeucoの対応表を消す。Codexに保存された履歴自体は消さない。失敗した依頼は自動再実行せず、次の依頼時にCodex接続を復旧する。処理中にCodexが終了してもdaemonは維持し、失敗した依頼の原因とrequestIdを記録する。

`LEUCO_HOME` の標準値は `~/.leuco`。空文字はエラーになるため、標準値へ戻すときは環境変数を解除する。相対パスは呼出元の作業ディレクトリを基準に解決する。ライブラリの明示的な`home`も空文字を受け付けない。

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

macOS/Linuxでは状態ファイルと設定は0600、ホームは0700で作成する。

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

Slack Web APIが明示的にHTTP 429を返し、応答の後片付けまで成功した場合だけ、一度再試行する。Retry-Afterの待機は最大30秒、欠落・不正値では1秒。キャンセル後は再試行しない。通信失敗・timeout・429以外のHTTPエラー・結果不明の場合や、ファイル本体の転送は自動再送しない。AIがCLIの失敗後に同じ投稿を自動でやり直してよいという意味ではない。

### 反応するイベントの設定

`slackReception` はモデルを呼ぶ前の受信ルール。既存設定にも以下の初期値を適用する。DM・メンション・Bot自身の投稿を受信して参加を確認したスレッドの続きだけを受け付け、通常投稿とリアクションはモデルを起動しない。参加スレッドの記録は最大500件で、daemon再起動時にリセットする。

```sh
leuco config set slackReception '{"directMessages":true,"mentions":true,"participatingThreads":true,"channelMessages":false,"reactionAdded":[],"reactionRemoved":[],"allowedChannels":null,"deniedChannels":[],"allowedUsers":null,"deniedUsers":[]}'
leuco restart
```

各項目は省略すると初期値に戻る。`slackReception` 全体を置き換えるため、変更時は残したい項目も渡す。資格情報の参照IDは不要。

- `directMessages` / `mentions` / `participatingThreads` / `channelMessages`：種類ごとの受付。DM、明示メンション、参加済みスレッド、通常投稿の順で分類する。例えばDMを無効にすると、DM内のメンションでも起動しない。
- `reactionAdded` / `reactionRemoved`：起動する絵文字名の配列。例えば `["eyes", "robot_face"]`。コロンを付けない。追加・削除は別々に指定する。Bot自身のリアクションは常に除外する。Slack App側でも対象イベントの購読が必要。
- `allowedChannels` / `allowedUsers`：許可するSlack IDの配列。`null` は制限なし、`[]` は全件拒否。チャンネル制限はDMにも適用する。
- `deniedChannels` / `deniedUsers`：拒否するSlack IDの配列。許可指定より優先し、全イベントに適用する。

対象外イベントはCodexを呼ばず、進行リアクションも付けない。イベント履歴には残る。リアクション起動を許可すると、そのイベントはCodexへ対象メッセージのIDとともに渡る。これは安価な外部モデルによる事前判定や自動リアクションの設定ではない。

Slack threadごとに会話を分ける。受信した本文に宛先と返信方法を添える。Codexのfinal answerは内部出力で、Slack本文として自動投稿しない。返信はCodexが明示的に実行するCLI操作で送る。進行状況のreactionは `ackMode` で `off` / `mention` / `always` を選ぶ。

履歴・検索・会話一覧を取得する場合も`slack call`で必要なAPIを明示する。応答を独自の空配列へ置き換える専用ヘルパーや、暗黙の履歴取得は持たない。methodと引数はSlackの公式仕様で確認する。

```sh
leuco slack call chat.postMessage --body '{"channel":"C123","thread_ts":"123.456","text":"こんにちは"}'
leuco slack upload-file --channel C123 --file ./report.pdf
leuco slack download-file --file F123 --out ./download.pdf
```

Slack操作は起動中のdaemonへ依頼し、daemonが保持したトークンで通信する。upload元の読み取りとdownload先への書き込みは呼び出し元のCLIで実行し、daemonにファイルパスの読み書きを代行させない。

`leuco` をCodex子プロセスの `PATH` から実行できるようにしておく。Slackの本文は外部入力であり、共有Codex環境へのアクセス権限を持つ。詳細は [SECURITY.md](SECURITY.md)。

## Discordを使う場合

Slackと同時に、一つのDiscord Botを接続できる。受信はflumeのGateway、送信はSDKを使わないREST API v10。Discord Developer PortalでBotを作り、**Message Content Intent**を有効にする。対象サーバーへBotを招待し、View Channels / Send Messages / Read Message History、スレッド利用時はSend Messages in Threads、リアクション操作時はAdd Reactionsを許可する。

```sh
leuco stop
# 人がDeveloper PortalでBot tokenそのものをコピーする。AIへ値を渡さない。
leuco discord login
leuco start
leuco status
```

`login` はクリップボードからOSストアへ直接保存し、設定には資格情報の参照IDと `messageContent` だけを残す。保存成功はDiscord認証成功を意味しない。起動時にBotの本人確認とGateway接続を行う。削除は停止後に `leuco discord logout`。トークンを引数・設定・環境変数へ渡さず、Codexにも渡さない。

`discordReception` はSlackと同じ種類の受信ルールに、`allowedGuilds` / `deniedGuilds`（サーバーIDの許可／拒否）を追加したもの。**DM・メンション・参加済みスレッドが初期値で有効**。通常投稿とリアクション起動は無効。対象外ではモデルを呼ばない。許可リストの `null` は制限なし、`[]` は全拒否。拒否リストを優先する。サーバー制限はDMには適用せず、チャンネル・ユーザー制限はDMにも適用する。

```sh
leuco config set discordReception '{"directMessages":true,"mentions":true,"participatingThreads":true,"channelMessages":false,"reactionAdded":["👀"],"reactionRemoved":[],"allowedGuilds":["123456789"],"allowedChannels":null,"allowedUsers":null}'
leuco restart
```

全体置換のため、省略した項目は初期値に戻る。Unicode絵文字はその文字、カスタム絵文字は `name:id` を指定する。リアクション用Gateway intentsは対象絵文字の設定時に有効化する。Bot自身のリアクション、自分や他Bot・Webhookの投稿では起動しない。

Discordのスレッドは独立したチャンネル。GatewayでBotのスレッド参加を確認した場合、またはBot自身のスレッド内投稿を確認した場合に、その後の投稿を受け付ける。退出・削除も反映する。参加記録は最大500件で、再起動時はGatewayの同期情報から再構築する。会話はDM／チャンネル／Discordスレッドごとに分かれる（通常チャンネル内の「返信」は同じ会話）。

`discord.messageContent` は標準で `true`。Portalでintentを許可できない場合は `config show` で取得した資格情報の参照IDを保ったまま `discord` 設定の `messageContent` を `false` にできるが、メンションなしのサーバー投稿・スレッドでは本文や添付情報が取得できない場合がある。詳細は [Discord Gateway仕様](https://docs.discord.com/developers/events/gateway#message-content-intent) を参照。

返信は明示的なCLI操作で送る。Codexのfinal answerは自動投稿しない。

```sh
leuco discord call GET /users/@me
leuco discord call POST /channels/123456789/messages --body '{"content":"こんにちは","allowed_mentions":{"parse":[]}}'
```

`call <HTTP method> <API相対path> [--body <JSON>]` がDiscord APIの入口。GETのqueryはpathに付ける。宛先IDを推測せず受信イベントかAPI結果から取得する。HTTP失敗・レート制限で書き込みを自動再送しない。添付情報の受信には対応するが、Slackのようなファイルupload/download専用CLIや処理中の自動ackリアクションは未対応。リアクション操作は `call PUT/DELETE` で明示的に行える。

## 予定

```sh
leuco schedules add --name morning --run-at '0 9 * * *' --prompt '今日の予定を確認して'
leuco schedules list
leuco schedules remove morning
```

cronはホストのローカル時刻、単発はタイムゾーン付きISO日時を使う。新規・日時変更時には、実在する日付とZまたは数値のUTCオフセットが必要。予定は毎分再読込されるため、設定変更の再起動は不要。

予定は常駐中のみ動き、CLI・Slackと同じ待ち行列で実行する。予定ごとに会話を分け、結果は内部履歴に残す。Slackなどへの通知が必要なら依頼に明記する。

実行前に受付を保存し、失敗や再起動後に同じ回の依頼を自動再送しない。受付後の電源断では、その回が実行されないことがある。単発予定の削除だけは再試行し、`status` のschedule接続にある `health.cleanup` で待機件数と次回時刻を確認できる。

日時変更・取りこぼし・後片付けの詳細は [予定の実行保証](.docs/reliability.md#予定の実行保証)。

## 運用

```sh
leuco status
leuco logs --limit 100
leuco events --limit 100
leuco doctor
leuco --help
```

同じ `LEUCO_HOME` で二重起動できない。`start` はバックグラウンド起動、`run --foreground` は明示的な前面起動。OS起動時の自動起動はOSのサービス管理で設定する。

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

過去の失敗と現在の状態を区別し、requestId・instanceId・発生時刻を照合する。停止中や状態不明の場合も、まずdoctorの診断と案内を確認する。

診断項目の場所、通信エラーの詳細、ログの配送・停止理由は [診断情報の読み方](.docs/reliability.md#診断情報の読み方)。

最初に `leuco events --summary --limit 20` で処理・接続・障害の流れを調べる。summaryはCodex内部通知とinfoレベルの通常ログを除外し、絞り込み後の最新件数を返す。該当するrequestIdが分かったら `leuco events --request <requestId>` で詳細を読む。summaryは保存済みイベントを書き換えない。出力には秘密のマスクを適用し、SQLiteと一時的なメモリ履歴で同じ表示規則を使う。

`codex.notification` はthreadIdとturnIdの一致を確認できた場合だけrequestIdを付ける。開始応答前の未確定通知や背景通知は、requestIdなしで保持する。依頼別の履歴に見当たらない通知は `leuco events --type codex.notification` で全体から調べる。

restartは受付結果を先に返し、独立したプロセスが停止と再起動を行う。Leuco内のCodex自身もCLIから再起動を依頼できる。進行と結果はstatusのmaintenanceとeventsで確認する。現在の依頼は中断され、再送しない。停止や起動の成否が確認できない場合はuncertainとして残し、見切りで二重起動しない。

repairは確認済みの古い制御情報とファイル権限を修復し、応答するdaemonのCodex接続が壊れていれば再起動を受け付ける。停止中なら起動しない。壊れた会話対応表は停止中の `leuco repair --reset-state` でのみバックアップ後に作り直す。設定やOS資格情報、Codex本来の履歴は上書きしない。応答しない生存プロセスを無条件に強制終了しない。ライブSQLiteのDB欠落を検出した場合はrepaired:false・restart:nullとし、doctorでの原因確認を案内する。既存DBの読取異常もissuesへ残し、独立した接続障害の復旧は引き続き受け付ける。

ログは本文を含むため扱いに注意する。既知の資格情報とSlack token形式をマスクし、通知・本文・行の長さを制限する。テキストログは約4MiBでローテーションし、過去3世代を保持する。SQLiteイベントには保存期限・件数・容量の保守があり、実際の制限値と保存失敗はstatusに表示する。起動時にDBが壊れているなど利用不能な場合は、元のDBを上書きせず最大1000件のメモリ履歴へ切り替え、イベントをテキストログにも記録する。statusはmemory-fallbackと保存異常を返し、doctorは非ゼロで診断結果を返す。稼働中のeventsはそのメモリ履歴を取得する。メモリ履歴は停止で失われるため、修復・再起動前に必要な履歴を取得する。daemonへ接続できなくても、eventsは保存済みDBを読める。

ライブ履歴の取得に失敗し、保存済み履歴だけが読める場合、eventsは終了コード5のSTATE_UNCERTAINを返す。部分的な履歴はerror.details.savedEvents、取得できなかった原因はerror.details.causesに残す。成功や完全な空履歴とは扱わず、処理が実行されなかった証拠にも使わない。制御確認は短い期限付きなので、daemonが応答しなくても保存済み履歴を調べられる。

ライブ履歴の形式も検証する。daemonがSQLite保存を報告しているのにDBファイルが消えている場合も、空の成功には置き換えない。通信のタイムアウトなどは標準のcauseに残し、別の診断エラーへ包み直しても元の原因を追えるようにする。

設定保存の成功後にロック解除が失敗する場合もあるため、エラーだけで未保存とは断定しない。処理と後片付けの両方が失敗した場合は、原因を両方残す。ロック情報は通常ファイルとしてサイズ制限付きで読み、FIFOを待って停止しない。JSONへ変換できない値はファイルを置き換える前に拒否する。

資格情報の保存失敗時は設定を読み直し、新しい参照が保存済みならそのOS資格情報を保持する。設定を確認できない場合も見切りで削除せず、復旧用の参照IDと両方の原因を返す。ログアウトは先にSlack無効化を保存してからOS資格情報を削除する。OS側の削除に失敗した場合は無効化済みであることと後片付けに必要な参照IDを返し、トークン値は表示しない。

ファイルのダウンロードは通信待ちの期限と後片付けの期限を分ける。キャンセル・ファイルclose・一時ファイル削除はそれぞれ最大1000msの確認待ちとし、失敗を隠さない。空チャンクはデータの到着と数えず、タイマーが動けるよう処理を譲る。不正なチャンクや使用済みの本文は拒否し、正常な転送・後片付けを確認してから保存先へ公開する。公開とキャンセルが競合した場合は保存先が変わっている可能性を示し、既存ファイルを見切りで巻き戻さない。

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

Bun専用。公開入口は `LeucoRuntime` と設定・状態の型。TypeScriptでは `bun add -d @types/bun` でBunの型定義を開発依存へ追加する。

内蔵のCodex接続はLeucoの名前と配布versionを通知する。権限・sandbox・基本のシステム指示を独自に上書きするオプションは持たず、通常のCodex設定に従う。明示的なSOULの追加は引き続き使える。

`LeucoRuntime.build` は依存先と接続構成の選択を保持する。渡したoptionsの差し替えで、既存Runtimeの資格情報ストアや接続の有無は変わらない。資格情報の値はbuild時には読まず、start時に一度取得する。

ライブラリの標準イベント保存先はメモリで、停止・プロセス終了後の永続保存はしない。標準では最新5万件を保持し、件数超過時に古い記録から破棄する。CLI常駐時の保存先はevents.db。期限とDB容量による保守はSQLiteに適用する。

`runtime.getStatus().logs` のmode・durable・memoryWritesで保存状態を確認する。memoryWritesはメモリ側で受け付けたイベントの累計で、現在の保持件数ではない。`getStatus()`は状態のコピーを返し、差し込んだCodex・接続アダプターの内部オブジェクトを呼び出し元へ渡さない。

`runtime.getVolatileEvents({ requestId, type, limit })` で保持中の履歴を新しい順に読む。requestId・イベント種別・日時・seqで絞り込める。返す履歴は現在の秘密マスクを適用したコピーで、受信側の変更は保持中の記録へ反映されない。limitは０以上の安全な整数で、０は空配列、不正値はRangeErrorになる。

onLogには同期・非同期の受信関数を渡せる。引数は本文・level・任意のrequestIdで、背景ログの第三引数はundefined。従来の一引数・二引数の関数もそのまま使える。非同期の完了は1秒まで、同時に64件まで観測し、失敗はstatusのlogConsumerと構造化イベントへ記録する。受信側への再送はしない。stopは受信処理の観測を終えてから所有するイベントログを閉じる。

Runtime自身が作ったイベントログはstopで閉じる。eventLogを渡した場合は呼び出し元が所有し、Runtimeの停止・起動失敗後も記録できる。共有するHTTP処理などの終了を待ってから、呼び出し元が最後にcloseする。

イベント保存・障害報告・close失敗の診断は [履歴とログの設計](.docs/reliability-design.md#履歴とログ) を参照する。

会話キーはUTF-16単位で512まで。例えば `😀` は2単位として数える。CLIの `--thread` とライブラリの `runTextTurn` で同じ上限を使う。

Slackを直接操作する場合は `runtime.runSlackCommand(parsed, { upload, requestId, signal })` を使う。第二引数は省略可能な `SlackCommandOptions`。Slack通信の失敗・キャンセルでは、causeも既知の秘密をマスクしたコピーで返し、コード・スタックを上限付きで保持する。CLIの切断とruntime停止はSlack通信・429待機へキャンセルを伝える。停止は進行中の操作を最大1500ms確認し、確認不能なら失敗を返す。キャンセルは外部で受理された操作の取り消しを保証しないため、自動再送しない。

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
