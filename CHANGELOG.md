# Changelog

All notable changes to Leuco are documented here.

## 0.18.0 - Unreleased

### 設計・互換性

- 一つのCodex app-serverを動かすCLIへ変更。project登録、supervisor、connector登録、旧boot管理とHTTP gatewayを廃止。
- 通常のCODEX_HOMEをそのまま使用。Codex設定の生成、認証symlink、内蔵prompt presetを廃止。
- 追加指示は明示的なSOULだけ。`--soul` / `--no-soul` で選択し、指示変更時は新しい会話を使う。
- 会話キーごとの再開と一つの直列queue、任意のSlack接続一つ、flatな予定管理を提供。
- Unix socketとtokenでローカル制御。失敗した依頼を再実行せず、次の依頼でCodex接続を復旧。
- 公開APIはLeucoRuntimeと単一設定・状態の型に整理。旧APIとの互換性はない。

- CLIの通常操作と公開ライブラリのimportはpackage.jsonのBun要件を確認し、未対応版を操作開始前に拒否。CLIはCHECK_FAILEDで必要な範囲と現在版を返し、helpとversionの表示は維持。

- Node.jsで名前付きimportした際も、export不足ではなくBun専用である旨と導入先を表示する。配布物の検証に静的・動的importの案内確認を追加。

- 廃止済みTUIと旧起動方法を案内するMakefileを削除。操作はleuco、開発・検証はpackage.jsonのbun runスクリプトへ集約。

- 更新系コマンドのhelp出力が失敗しても、操作を実行していない場合はmutationMayHaveOccurred:falseを返す。本文として渡した--helpは通常の実行依頼として扱う。version出力失敗もcommand:versionとして識別する。

- Slackの完了・失敗診断から停止された場合、新しい完了・失敗reactionを送らず、付与済みの進行中reactionの削除だけを行う。

- 同期の診断コールバックから依頼追加・停止が呼ばれた場合も、実行は直列、待機バイト数は整合、終了処理は一度だけになるよう状態の確定順序を修正。停止要求後のCodex再接続も実行前に拒否。予定の開始中に停止した場合のタイマー残存と、失敗診断からの重複tickも防止。記録後に停止した予定はキューへ渡さず、保存済みの判断を保持して再実行を防ぐ。

- 単一ランタイムでは使われない履歴queryのruntimeフィルターを削除。requestId・種別・日時・seqによる絞り込みと保存済みイベントの正規化は維持。

- Slack入力の未使用の内部識別名・ack絵文字上書きと型別名を削除。識別名と絵文字は標準値に固定し、ackModeの選択は維持。

- 未使用のSlack自動返信向けpostReply経路と専用chatPostMessageメソッド・型を削除。本文送信は明示的な`slack call`を使い、connectorのadapterはreactionだけを扱う。

- Slackの履歴・検索・会話一覧向けの未使用ヘルパー5つと、関連する正規化schema・型・テスト用実装を削除。必要な読取は既存の`slack call`へ統一。

- 内蔵Codexクライアントの未使用の権限・指示上書き型、非テキスト入力型、文字列での旧turnオプション、独自のclientInfo指定を削除。送信する項目と引数形式を実際のLeucoの利用に絞った。

- `config`・`schedules`・`session`の暗黙の表示コマンドを削除。実行は`config show`・`schedules list`・`session list`へ統一し、グループ別helpは維持。

- ライブラリAPIの`LeucoRuntimeProps.model`を削除。モデルは通常のCodex設定を使い、専用の固定値は保存設定の`model`だけに集約。

- CLIの起動ごとの`--model`・`--codex-bin`上書きと、単発起動の`run --prompt`を削除。CodexはPATHから解決し、依頼は`start`した一匹への`ask`へ統一。人の前面起動は`run --foreground`を使う。

- 新しいイベントから固定のruntime名・connector名を削除し、イベント種別・instanceId・requestIdで識別する。SlackチャンネルIDや予定IDは維持し、過去ログのruntime・connector値も引き続き読み取れる。

### 信頼性・診断

- SDKへ返すSlack失敗・キャンセルのError.causeもマスク済みの診断コピーへ置き換え、元のエラーに含まれる資格情報を呼び出し元へ残さない。原因のコードとスタックは保持する。

- イベント保持上限のNaN・Infinity・負数・小数などを保存先の作成前に拒否する。容量上限だけを小さく指定した場合も既定の縮小目標を上限内に収め、メモリ履歴の無制限化や不整合な保守条件を防ぐ。

- session resetは既に稼働中の所有者をホーム準備より先に確認して拒否し、権限や保存済み状態を変更しない。事前確認後の所有競合は、操作本体が未実行でも準備によるローカル情報の変更可能性を返す。

- 制御APIの未対応クエリ引数を実行前に拒否し、forceなどを黙って無視して停止・再起動・依頼実行へ進まない。eventsの対応フィルタは引き続き受け付ける。

- 停止APIの本文を検証し、未知の入力・非object・壊れたJSONでは停止を実行しない。既存の空本文と空objectによる停止は維持する。

- Slack実行APIへhelpフラグを渡しても外部操作へ進まないよう、SDK・JSON・multipartの境界で実行前に拒否する。CLIのhelp表示は従来どおり実行せず返す。

- Slack操作の引数・操作種別の検証を共有し、公開APIもローカル制御と同じUSAGE・executionStarted:falseで実行前の拒否を返す。

- Codex通知の実行IDを一か所で正規化し、turnIdとturn.idが矛盾する通知を現在の依頼や活動通知へ関連付けない。元の通知は独立した履歴に残す。

- Codex通知のrequestIdはthreadId・turnIdの一致を確認できた場合だけ付与する。背景通知・古いturn・開始応答前の未確定通知を現在の依頼へ混入させず、独立した履歴として保持する。

- 完了・タイムアウト済み依頼の遅延activityを無視し、requestIdを再利用しても次の依頼の診断状態を書き換えない。

- SDKの会話キーを稼働状態の判定前に検証し、不正な長さのキーを拒否イベントへ保存しない。

- Codexの準備完了ログから停止された場合、接続の有効性を再確認し、起動成功として返さない。

- Slackの起動診断から停止された場合、後続の認証確認・Socket接続を始めず、起動成功も返さない。

- SOULの不正なUTF-8を置換文字へ変換せず、原因を保持して起動時に拒否する。正常な本文とBOMはそのまま保持する。

- 起動完了の診断コールバックで停止した場合、startを成功として返さず停止済みの起動失敗として扱う。

- 会話復旧の診断中に停止した場合、代替Codex会話の作成も実行前に中止する。

- Slack制御入力のflagsでリテラルキーを保持し、未知のフラグが検証中に消えて実行される問題を修正。引数と操作種別の拒否は、原因を保持したUSAGE・executionStarted:falseで返す。

- Slack APIの認証用token除外を共通クライアントへ集約し、薄いslackCallラッパーを削除。JSON本文のリテラルキーを保持し、呼び出し元の本文は変更しない。

- config set schedulesの一括変更にも予定日時の検証を適用。無効な式・新規や日時変更による過去の単発予定を保存前に拒否し、同じID・日時の保存済み予定は過去になっても読み取りとcatch-upを維持。検証は書き込み時の最新設定でも行う。

- エラーのname・stack・code・cause・AggregateErrorの原因を読む処理を保護。getterや型判定が失敗しても診断全体を落とさず、読めない項目を明示して読める元の原因と後続の原因を保持。取得中に発生した別例外の文面はログへ持ち込まない。

- turnTimeoutMsとidleTimeoutMsをネイティブタイマーの安全な範囲1〜2147483647msへ制限。大きな値が1msとして実行される問題を防ぎ、設定保存前とturnのタイマー生成前の両方で拒否。公開settings schemaとヘルプも同じ範囲を示す。

- ローカルJSONの保存上限を既定の読み取り上限16MiBと共通化。整形・UTF-8化・末尾改行を含むサイズをファイル操作前に検査し、次回読み込めない設定・状態を上書きしない。Memory実装も同じ検証を使う。

- Slack資格情報の登録・ログアウトとセッション初期化の予約解除を共通化。成功出力は解除確認後だけにし、本体と解除の両方の原因を保持。解除未確認はSTATE_UNCERTAINへ操作完了の有無を残し、予約トークンを伏せる。

- 保存済みイベントの読み取り・解析と保存期間整理で、close失敗が元の障害を上書きしないよう共通後片付けへ統一。読み取り専用と一度だけのcloseを維持し、元のOSコード・SyntaxErrorと後片付けの原因を併記。

- 同じ再起動操作の進捗更新はjournalの最新の補助イベント診断を引き継ぐよう修正。復旧時はeventLogErrorだけを解除しeventLogCausesは保持するため、古いworkerの状態で診断を消したり障害表示を復活させたりしない。復旧注記の保存失敗も正本保存済みとして未確認状態を返す。

- maintenance journalの保存と補助イベントDBの失敗を区別。イベント書き込み・close・stderr報告の原因をeventLogCausesへ保持し、報告だけの失敗で保存済み操作を失敗扱いにしない。障害注記も保存できない場合はjournalWritten:true付きSTATE_UNCERTAINで正本の保存済み状態を明示。

- 再起動workerの同期spawn失敗をfailedとして保存し、非同期失敗でも実際のOSコード・原因を保持。失敗の記録も失敗した場合は両方の原因を維持。workerの監視・detachをPID公開より先に行い、公開不能・所有権変更では受付成功と断定せずSTATE_UNCERTAINへoperationIdとworkerPidを返す。

- 通常起動と再起動workerの子プロセス起動を共通化。spawnが同期的に失敗してもログ記述子を閉じ、spawnとcloseの両方の失敗を保持。子の監視とdetachをcloseより先に行い、起動依頼後の後片付け失敗ではSTATE_UNCERTAINへPIDと原因を残す。workerのjournalにも新PIDを維持。

- イベントDBと予備テキストログの同時失敗で、両方の原因列・コードを保持。予備ログの例外が文字列化できなくても元のDB障害を失わず、予備ログが失敗しても成功したメモリ保存件数と揮発履歴を維持。

- メモリ履歴のCLI応答について、新しい順・連番の重複なし・要求件数・検索条件も検証。形式だけ正しく検索条件を無視した応答を成功として返さず、STATE_UNCERTAINへ保存済み履歴を残す。

- 稼働中のSQLite daemonがイベント保存失敗を報告した場合、eventsを成功の空履歴として返さずSTATE_UNCERTAINへ保存済み履歴と保存障害の情報を残す。書き込み復旧後も、そのdaemonが把握する履歴欠落の可能性を維持。

- イベントDBの保存失敗をlastPersistErrorの原因列・コード・スタックへ保持。stderrへの障害報告も失敗した場合は両方を記録して継続し、復旧後も直近の原因を調査可能にした。報告文の改行・端末制御文字を可視化し、再報告の間隔を時計補正から切り離した。

- Codex処理・待ち行列・Slack操作の所要時間を単調増加する経過時間から算出。時計の巻き戻しで負の所要時間になり完了イベントが保存されない問題と、時刻の補正を処理時間へ加算してしまう問題を修正。日時の記録は実時刻を維持。

- 文字列へ変換できないthrow / Promise失敗でも診断処理が二重に失敗しないよう修正。安全な表示を残し、同じ障害の後片付け原因や未処理例外の終了処理を維持。

- 診断用のエラー原因は既知の秘密情報をマスクしてから省略し、切り詰め境界にトークンの断片が残る問題を修正。エラー名にも上限を設け、長いフィールドの省略を明示し、絵文字を分断しない。

- 停止受付後のプロセス終了確認にも呼び出し元キャンセルを適用。リソース停止済みとプロセス終了未確認を区別し、対象PID・観測キャンセル・原因を残したまま待機を終了。

- 稼働中の制御トークンをイベント保存・ローカルJSON応答・通信エラーの原因列でマスク。Slack資格情報の読み込みで既存のマスク対象を消さず、OSエラーコードと原因の順序は保持。

- 起動・停止・再起動worker・ロック取得・downloadの待機予算を単調増加する経過時間で管理。実時刻が補正されても待機が延長し続けないよう修正。予定日時、journal・ログの時刻、ファイル更新日時による古さの判定は実時刻を維持。

- 起動・再起動のreadiness確認を共通化。未確認時に対象PID・最後の応答・確認回数・直近の通信失敗を残し、単に起動中と断定しない。CLIの待機キャンセルを伝え、確認済みの子プロセス終了・spawn失敗の原因も維持。

- ライブstatusのPIDを通信開始時の所有情報と照合し、応答後にも所有情報の変化・消失を確認。別PID・不完全なstatus・ライブ接続からの停止主張を信頼せず、doctor・repair・履歴取得・起動確認にも同じ検証を適用。所有情報やトークンの不一致を理由に自動で操作しない。

- 全コマンドの成功出力を公開outputSchemaで検証してからstdoutへ書き込むよう修正。マスク・JSON化後の欠落も検出し、不正な結果はSTATE_UNCERTAINへ検証箇所を返す。status・start・restartのスキーマを実際の必須項目とそろえ、バージョン出力にも共通の契約を適用。

- CLI側のdaemon応答もJSON 16MiB・エラー本文1MiBで制限し、ヘッダーと本文に同じ期限を適用。成功応答の本文を確認できない場合はSTATE_UNCERTAINとし、JSONでないHTTPエラーでもステータスと解析・後片付けの原因を保持。

- JSON制御依頼を受信中から4MiB・5秒で制限し、上限超過・停滞した本文を依頼受付前に拒否。multipartのcommand欄もJSON解析前に4MiBを適用。Slack用の上限付きJSON読み取りを共通化し、後片付け失敗も原因と併記。

- 設定・SOUL・ロック・ログの読み取り上限を、事前のファイルサイズだけでなく実際の取得バイト数にも適用。読み取り中の増加でも上限超過を拒否し、分割UTF-8・BOM・元の読み取り失敗とclose失敗を保持。

- 新しいテキストログは改行・復帰・端末制御文字を可視化し、一回の書き込みを一行に保持。保存時の長文省略も明示し、トークンのマスク後に文字・エスケープ列を分断せず上限を適用。

- テキストログ保存失敗のOSエラーコード・原因列をstatusのruntime.textLog.lastFailureとeventsへ保持。書き込みが復旧しても直近の失敗を調査可能にし、書き込みとclose、stderrへの報告が重ねて失敗した場合も元の原因を保持。

- logsは保存済みの最大3世代も必要な分だけ読み、ローテーション直後に直前の履歴を見失わないよう修正。巨大な行は省略を明示して出力を制限し、読み取り時に全行を配列化しない。ログのシンボリックリンクは拒否。

- statusへ進行中のSlack操作を追加。Codexの待ち行列と独立してrequestId・種別・開始時刻・経過時間・キャンセル要求を表示し、本文・宛先・ファイル名を出さない。キャンセルを要求しても処理の終了が未確認なら表示を残す。

- CLI切断・runtime停止のキャンセルをSlack API・429待機・upload・downloadへ伝播。停止時は進行中のSlack操作を期限付きで確認し、確認不能を停止成功にしない。キャンセルのログには外部操作の受理が未確定であることを残す。ライブラリのrunSlackCommandは第二引数のoptionsへupload・requestId・signalを集約。

- Slack APIと外部ファイルuploadの通信期限を、AbortSignalを無視するfetch・本文にも適用。応答の破棄を期限付きにして、HTTPステータスと後片付けの失敗を保持。429応答を閉じられなければ再試行しない。JSON読み取りも反復処理へ分離し、不正チャンクを拒否。

- Slackファイル取得はリダイレクト全体で期限を共有し、外部AbortSignal併用時もタイムアウトを維持。途中の接続終了に失敗したら次へ進まず、HTTPエラー・転送元の異常と後片付けの原因を併記。

- ダウンロードでAbortSignalを無視する応答・読み取り・キャンセルが無期限待ちになる問題を修正。後片付けも期限付きにし、削除失敗・元の原因を保持。不正チャンクを拒否し、空チャンクでデータ待ち期限を延長しないよう修正。

- ロック解除・一時ファイル削除・ファイルcloseの失敗を隠さず、元の処理失敗と併記。FIFOロックを上限付きの非ブロッキング読み取りで拒否し、JSON化できない値で既存状態を置き換えないよう修正。
- 資格情報の設定保存がエラーを返した場合は保存済み参照を確認し、参照中の新資格情報を巻き戻しで削除しない。ログアウトも設定無効化を先に保存し、失敗時に有効な参照だけが残らないよう修正。

- ライブ履歴の取得失敗を保存済み履歴の成功へ置き換えないよう修正。STATE_UNCERTAINに部分履歴と原因を含める。予定の重複・日時不正は保存前の入力エラーとして返す。
- 通信エラーを標準causeでも保持し、診断の包み直し後も元のタイムアウトを追跡可能に。ライブ履歴の不正な応答と、稼働中のイベントDB消失も空の成功へ置き換えない。

- doctorの失敗履歴が大量の内部通知に埋もれる問題と、SOUL・Codexの指定先ディレクトリを正常扱いする問題を修正。診断を設定・起動環境・制御・履歴へ分割。
- startの前へ置いた起動optionが失われる問題を修正し、検証済みの引数を起動処理へ直接渡す。前面実行と停止処理もCLIの出力・振り分けから分離。

- Codexの構造化stderrと接続元のログ重要度を保持。stderrを上限付きで行単位に組み立て、分割受信による重要度の消失とトークンマスクの抜けを防止。テキストログへ重要度を表示。
- events --summaryで内部通知とinfoログを除外し、処理・接続・障害を確認可能に。件数制限より前に絞り込み、詳細履歴は保持。

- 起動失敗のCLIエラーへ子PID・終了コード・signal・マスク済み直近ログを追加。制御情報の破損時は停止と断定せず、起動・状態リセットの誤案内を抑止。
- 停止受付の理由をイベントとテキストログへ記録。CLI停止のrequestId、OSシグナル、abort、内部異常を区別。

- doctorが停止中を正常と誤判定する問題を修正。Slack返信用CLIのPATH検査と、起動・bun link・PATH修正の案内を追加。

- FlumeClosed.errors()の停止失敗を検査し、終了未確認のソケット上に次の接続を開かないよう修正。watchdogの登録・解除失敗とconsumer例外を診断へ残す。

- Slack登録を一つずつコピーしたトークンのクリップボード読み取りだけへ限定し、手入力・stdin・トークン引数・interactive flagを廃止。読み取りのサイズと時間を制限。
- CLI所有のBotは未処理例外後に自動復旧し、60秒内3回で再起動ループを停止。起動識別情報と操作IDで古いworkerの誤操作を防止。

- 初期化中の停止、後片付けの失敗の隠蔽、元の原因の上書き、単発予定の自動再送を修正。Codexの初期化・停止を直列化し、終了未確認のプロセスを保持。
- 原因の連鎖・スタック・コード、入力接続の健全性、未処理例外の記録と終了処理を追加。イベントDB障害時は明示的なメモリ履歴とテキスト記録で継続。
- 障害注入の実プロセス検証と全検証scriptの型検査を追加。

- 結果を標準YAML / 任意JSONへ統一し、requestIdを追加。通常CLIの入力待ちを廃止し期限を設定。前面常駐は明示optionで選ぶ。
- 独立workerによるrestart、安全なrepair、診断・待ち行列・ログ保存健全性、依頼別イベント検索とログローテーションを追加。
- Flumeを0.12.0、publintを0.3.25へ更新。

- AI向けの個別helpとそのJSON版、JSON結果とエラーコードを追加。コマンド契約から引数検証とCLI.mdを生成し、生成差分と実CLIを検査。読み取り時にホームを生成せず、eventsをSQLiteの読み取り専用queryへ変更。

- 対応Bunを1.4.4以上へ変更し、Windowsの端末内資格情報保存を指定。
- Slack tokenをOS資格情報ストアへ保存し、起動時に一度だけ読む形へ変更。login / logoutとクリップボード登録を追加し、設定は参照IDだけに変更。Slack操作はdaemonへ中継し、ファイルIOは呼び出し元に維持。

- Zodと検証用ツールを修正版へ更新し、既存依存の脆弱性を解消。

## 0.17.6 - 2026-08-05

### Added

- 埋め込みconsumerが`LeucoRuntime.build()`の`hostInstructions`でstandalone Leuco CLI向けのprompt部分だけを置換できるように追加。Slackの宛先判定と明示書き込み境界は共通ルールとして維持。

## 0.17.5 - 2026-07-31

### Added

- Programmable APIの`LeucoRuntime.build()`で`codexAuthPath`を指定し、project別`CODEX_HOME`の挙動を変えずに任意のCodex認証を共有できるように追加。

## 0.17.4 - 2026-07-30

### Fixed

- cronのfire decisionをturn実行前に永続化し、保存失敗やCodex turn失敗後に同じoccurrenceを重複実行しないように修正。
- 壊れたproject `state.json`をsession resetでcanonicalな空stateへ置換し、CLIから復旧できるように修正。
- 実行中のSQLite Event Logでバイト上限を正しく計測し、長時間稼働中も古いeventを削除するように修正。
- Slack DM診断でthread replyを含む最新human messageを選び、最新turnより古いterminal eventを誤用しないように修正。

## 0.17.3 - 2026-07-30

### Fixed

- daemon readiness確認をglobal `fetch`から独立させ、失敗時にlog pathと原因を診断できるように修正。
- process identityの一時的な取得失敗をdaemon停止と誤認せず、`leuco status`が稼働中または置換後のPID leaseを削除しないように修正。
- project runtimeの停止失敗時は旧runtimeを保持して再試行し、停止完了前にreplacementを起動しないように修正。
- `LeucoRuntime.stop()`後の`start()`を明示的に拒否し、gatewayだけが再起動する半起動状態を防止。

## 0.17.2 - 2026-07-29

### Fixed

- `exec-UUID`形式のcommand output overflowでも、繰り返し失敗するCodex threadを破棄して復旧。
- 誤って削除されていた`leuco update`と`--check`を復旧し、公開前versionからのdowngradeを防止。
- 0.17より前のEvent Logをread boundaryで現行のruntime、supervisor、connector形式へ正規化。
- `leuco doctor`の出力からSlack tokenの断片を除去。

## 0.17.1 - 2026-07-29

### Fixed

- Codexのfinal answerをSlackへ自動投稿せず、すべてのSlack書き込みを明示的なproject scope付き`leuco slack call`に限定。

## 0.17.0 - 2026-07-28

### Added

- ホストのsleep復帰後に停止したSlack Socket Mode接続を検知し、安全に再接続。
- 汎用Event Logとmemory、SQLite実装をLeuco本体で提供。

### Changed

- package rootの公開APIを、runtime、project、connector、Event Logの安定した契約に整理。
- channelをconnectorへ、Event JournalをEvent Logへ改称。
- Funnelへの依存を削除し、runtimeとCLIの責務を簡素化。

## 0.16.1 - 2026-07-28

### Fixed

- 0.16より前の数値PIDファイルを、安全確認後にupdate、restart、stop、reload前に移行。
- `leuco doctor` でversion付きdaemon PID leaseを正しく診断。

## 0.16.0 - 2026-07-28

### Changed

- Leuco内蔵MCP serverを廃止し、Slack、file、schedule操作をproject scope付きCLIへ一本化。
- Codex子へ `LEUCO_PROJECT_ID` を渡し、別projectを明示したCLI操作を実行前に拒否。
- system promptとtenant設定から内蔵MCP tool、endpoint、bearer tokenを削除。利用者設定の外部MCPは維持。

## 0.15.1 - 2026-07-26

### Changed

- Let `leuco slack dm --project <name>` discover and diagnose the latest human DM without requiring a conversation ID.
- Include daemon and Slack connection state in DM diagnostics, with token-specific remediation when Socket Mode delivery is missing.

## 0.15.0 - 2026-07-26

### Added

- Detect Codex turns that stop producing notifications and replace the stalled child.
- Apply the hard turn deadline while starting or resuming Codex threads, and reject stale replies from replaced children.
- Bound queued turns by count and UTF-8 bytes, with structured overload events.
- Record turn queue depth, wait time, batch size, duration, and Codex recovery outcomes.
- Add the `recovery` event-log preset.
- Make hard and idle turn timeouts configurable through machine-wide settings.
- Bound structured event-log age, rows, file size, and persisted turn payloads.
- Export constructor option types, configuration schemas, and event schemas from the package root.
- Add cross-platform CI, package isolation checks, coverage floors, and dependency auditing.

### Changed

- Update Funnel, Flume, Hono, and Vite Plus.
- Correct package repository metadata and include the MIT license.
- Publish self-contained declaration files that resolve outside the source repository.

### Security

- Pin patched transitive versions for known Hono, body-parser, fast-uri, and PostCSS advisories.
- Reduce the dependency audit result from fifteen known vulnerabilities to zero.
