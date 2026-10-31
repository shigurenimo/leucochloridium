# 障害検証と実機確認の記録

調査の入口は [障害調査と復旧](reliability.md)、現在の契約は [障害時の設計詳細](reliability-design.md) を参照する。ここに記録した過去の検証結果は、現在の稼働状態や最新版の通過件数を示すものではない。現在の結果はverifyの実行出力、実環境はstatus・doctorで確認する。

## 回帰の証拠

`slack-api-response.test.ts`はauth.testの不正なIDをnullで成功扱いせず、ZodErrorを保持して一度の通信で失敗することを確認する。`slack-auth-diagnostics.test.ts`は差し込まれたclientのnull・空白IDでSocketのstartを呼ばず、認証エラーを一件記録することを確認する。修正前は計10件が失敗した。`verify-slack-http.ts`はBunの実プロセスでも不正なIDの拒否とschemaの原因を確認する。

`slack-api-response.test.ts`はHTTP 200で返るnull・配列・文字列・数値・ok欠落・不正型・Slackエラーを成功扱いせず、一度しか送信しないことを検証する。修正前は8件すべてが失敗した。`verify-slack-proxy.ts`は同じ応答を偽fetchで実APIクライアントへ返し、実CLIがOPERATION_FAILED・mutationMayHaveOccurred=trueを返し、再送せずrequestIdで失敗ログを調べられることを確認する。

Codex CLI 0.163.0の`app-server generate-json-schema`が出力するItemCompletedNotificationで、commandExecutionのexitCode・durationMs、MCP・dynamicToolCallのdurationMsがnullを許すことを照合した。`to-bounded-codex-notification.test.ts`は同じnullを含む巨大な出力・結果を要約し、本文を残さないことを検証する。修正前は3件が失敗した。`verify-noninteractive.ts`は実daemonのMCP完了通知で、秘密マスクと文字数上限を守りつつdurationMs=null・hasResult=trueを保持し、結果本文を複製しないことを確認する。

`to-bounded-codex-notification.test.ts`はphase省略とnullの両方で巨大なツール結果を要約し、本文をログへ残さないことを確認する。nullのケースは修正前に失敗した。`verify-single-companion.ts`はphase=nullの240万文字の完了通知を送り、依頼が容量超過で失敗してもeventsには文字数と相関情報だけが残り、本文や汎用previewへ戻らないことを確認する。

`handle-daemon-request.test.ts`は再起動APIの相対cwd・SOULと空文字を入力エラーとして拒否し、callbackを呼ばないことを確認する。`maintenance-store.test.ts`は不正なworkingDirectory・cwd・SOULの書き込みで既存記録を保持することを確認する。修正前は計7件が失敗した。`verify-cli-contract.ts`は実daemonで入力エラーとjournal無変更を検証し、`verify-single-companion.ts`はCLIの相対cwd・SOULが呼出元基準で絶対パスとして記録され、通常どおり実行できることを確認する。

`handle-daemon-request.test.ts`はrestartの廃止オプション・不正なSOUL型・Slack flagsの型違いを実行前に分類し、callback内のUSAGEを未実行扱いにしないことを確認する。修正前は3件が失敗した。`verify-cli-contract.ts`は同じ再起動・Slack入力を実daemonへ送り、構造化されたissuesとmutationMayHaveOccurred=falseが届き、maintenance journalを変更しないことを確認する。

`read-control-json.test.ts`は容量超過・受信timeout・キャンセル処理のtimeout・不正JSONの元の原因と実行前判定を確認する。`handle-daemon-request.test.ts`はturn・restart・Slackで壊れたJSONを受けてもcallbackを呼ばず、構造化されたUSAGEを返すことを確認する。修正前は8件が失敗した。`verify-cli-contract.ts`は実daemonへ4MiB超の本文を送り、CLI側までphase=control-body・executionStarted=false・mutationMayHaveOccurred=falseが届くことを確認する。

- `build-codex-child-env.test.ts` は大小文字が混在するtoken名、旧project ID、LEUCO_HOMEを確認し、親の環境と通常のCodex認証が保持されることを検査する。`verify-single-companion.ts` は偽Codexの実環境をキー名だけで観測し、token／旧IDがなく、Leucoホームが一つであることを確認する。

- `codex-client-limits.test.ts` はプロトコル・タイマー・出力量の不正なオプションを子プロセス境界で検査し、spawnが呼ばれないことを確認する。出力上限0、プロトコル最小値、タイマー最大値の受付も確認する。既存のprotocol検証と実CLI検証で有効設定の起動を維持する。

- `verify-single-companion.ts` は実CLIのinitializeでパッケージversionが通知されることを確認する。`verify-reliability.ts` は二度の起動でLeucoの名前とパッケージversionが保持されること、`verify-packed-package.ts` はインストール済みCLI／ライブラリ両方の通知versionが配布package.jsonと一致することを検査する。

- `repair-history.test.ts` はDB欠落を修復済みとせず、Codex停止が併発しても再起動要求を送らないこと、読取可能な履歴や既存の読取不能DBでは独立した接続復旧を受け付けることを確認する。`verify-reliability.ts` は実CLIでもDB欠落時のrepairがrestart:nullになり、再起動回数が増えないことを照合する。

- `inspect-diagnostic-history.test.ts` はライブSQLiteのDB欠落を異常とし、停止中・memory-fallback・観測なしでの未作成を許容することを確認する。`verify-reliability.ts` は実CLIのdoctorとeventsで同じ欠落を検出し、DBが新規作成されないことを検査する。

- `codex-consumer-diagnostics.test.ts` は同期／非同期出力失敗の原因・マスク・snapshot・後続の復旧、64件の上限、1秒でのdrain完了と古い成功応答の扱いを確認する。`verify-diagnostic-output.ts` は実際に読取側を閉じたstderrへ両方のcallback失敗を発生させ、偽Codexの応答成功・親のexit 0・status内のEPIPEを照合する。

- `format-codex-consumer-error.test.ts` は予備診断のマスク・文字数・Unicode・改行と制御文字の無害化・マスク失敗時の省略を確認する。`verify-diagnostic-output.ts` は実Codexクライアントを偽子プロセスへ接続し、log／notification callbackの例外を実ファイルに捕捉して秘密の断片が出ず、一行の診断を保つことを確認する。notification callbackの失敗を通常ログへ渡す経路でもerrorレベルとマスクを確認する。

- `get-bounded-validation-issues.test.ts` はpath/messageの上限をまたぐ長いURL資格情報が短縮前にマスクされることと、Unicodeを壊さず省略を示すことを確認する。

- `slack-reply-preview.test.ts` は通常応答の200文字境界に既知の秘密または絵文字を置き、実Runtimeのログcallbackと保存イベントの両方で秘密の断片が残らずUnicodeが壊れないことを確認する。同じ本文・requestIdと返答本体の非変更も照合する。

- `slack-turn-diagnostics.test.ts` は通常／巨大な依頼失敗で原因コード・相関IDを保持し、イベントとcallbackの両方で秘密を伏せて本文を制限することを確認する。Runtimeの`slack-diagnostic-log.test.ts` は依頼失敗も一件の構造化イベント・一回のテキスト配送になり、配送失敗時に再送せず健全性へ記録することを検査する。

- `slack-auth-diagnostics.test.ts` は認証失敗のslack.error一件に、マスク済みの親子のコード・メッセージ・スタックが入り、statusと一致することを確認する。呼び出し元へ返す認証エラーのcauseは元の例外を保つ。

- `slack-startup-cleanup.test.ts` は接続後の起動callback失敗とclose失敗を組み合わせ、両方のエラーコード・元のcause・Bot identityの解放を確認する。cleanup成功時は元のエラーオブジェクトを保持する。close失敗時も受付済みのturn完了を待ってから複合エラーを返すことを保留Promiseで検査する。

- `slack-startup-lifecycle.test.ts` は認証を保留した起動を停止し、新しいBot identityで接続してから古い認証を成功／失敗させる。新接続のstopが増えず、identityが保たれ、次のメッセージが新contextだけに届くことをMemory境界で確認する。

- `schedule-lifecycle.test.ts` は二重startと未完了tickを待つstop中のstartを拒否し、元のタイマーが増えないことを確認する。停止完了後は再開でき、最終stop後にタイマーが残らないことも仮想時計で検査する。

- `schedule-interval.test.ts` は0・負数・小数・非有限値・タイマー上限超過を起動前に拒否することを確認する。既定の60秒、1ms、最大有効値では実際にその時間までtickせず、1回tickした後に停止でタイマーを解放することを仮想時計で確認する。

- `read-daemon-log-lines.test.ts` は古い世代のinspect/read失敗で、取得済みのマスクされた行と元の原因を保持することを確認する。`verify-maintenance.ts` は正常／壊れたsymlinkを古い世代に置き、実CLIがexit 5と部分履歴を返し、リンク先の本文や合成トークンを漏らさないことを検査する。

- `slack-rate-limit-delay.test.ts` は空欄・空白・タブを1秒の既定値へ戻すことを確認する。`slack-http-deadlines.test.ts` は空のRetry-Afterで999msまで再送せず、1000msで一度だけ再送して完了後にタイマーが残らないことを確認する。

- `verify-storage-cleanup.ts` はファイル保存の全体／無通信待ち時間の上限超過を検査する。fetchが呼ばれず既存ファイルとディレクトリ内容が変わらないこと、上限ちょうどの待ち時間と最大安全整数のバイト上限では通常のUTF-8保存が成功することを実FSで確認する。

- Slack HTTPとファイル取得の待ち時間は、タイマー上限+1と最大安全整数で通信前に拒否されることを確認する。最大有効値では通常の応答を処理し、完了後にタイマーが残らないことを確認する。

- URLのuserinfoマスクはHTTP(S)/WS(S)・大文字scheme・複数の@・apostrophe・path内の@を単体で確認する。長いauthorityとqueryのない連結URLも検査する。偽Codexのstderrから実CLIの表示と保存イベントまで合成資格情報が残らず、host/pathとエラー理由が保持されることを確認する。

- `assert-slack-file-url.test.ts` はuserinfoの通信前拒否と不正URLの本文非表示を確認する。`fetch-slack-file.test.ts` はLocation欠落・上限超過・不正なリダイレクトでqueryやfragment・パスワードを診断へ残さず、同じ回数の通信とbodyの後片付けを維持することを確認する。

- `slack-upload-snapshot.test.ts` はアップロード準備応答を待つ間に元のバイト列・配列参照・filename・title・channel・thread・commentを変更し、最初の内容と宛先で送信完了することを確認する。Memory記録の独立性も照合し、既存のキャンセル・通信期限のテストを維持する。

- `redact-public-text.test.ts` は既知秘密の部分的な重なり、登録値と標準Slackトークンの重なり、置換マーカーの再処理なし、WebSocketクエリと既知秘密の合流、正規表現の特殊文字・Unicode・隣接する秘密を確認する。

- `redact-public-text.test.ts` は包含関係にある秘密の前方・後方一致と両方の登録順、変更できない秘密配列を検証する。`redact-json-secrets.test.ts` は引用符・改行などを含む同じ関係の秘密を値とproperty名へ置き、JSONを壊さず全体をマスクすることを確認する。

- `database-cleanup.test.ts` はJSONのUnicodeエスケープを含む保存トークンを復号後に全体マスクし、不正JSONでも本文を引用せずイベント連番と文字数・SyntaxError・接続closeを保つことを確認する。`leuco-event-log.bun-test.ts` は実SQLiteで同じ読取を確認し、元の保存行が変わらないことも照合する。

- `lib/engine/codex/codex-turn-id.test.ts` は受付・完了・関連通知の空turn IDを拒否し、正常なIDを加工しないことを確認する。`scripts/verify-single-companion.ts` は実JSON-RPCで受付と完了に同じ空IDを返し、成功扱いしないこと、送信済みとして変更の可能性を保持すること、後続の明示依頼以外を再送しないことを確認する。

- `lib/runtime/conversation-empty-id.test.ts` は空文字・空白だけのIDを応答・保存状態・差し込んだストアで拒否し、本文未送信・新規の対応表未保存を確認する。正常なIDの文字列は加工しない。`scripts/verify-single-companion.ts` は実JSON-RPCの空IDにも同じ拒否を確認し、バックエンドが正常なIDを返した後の新規作成も確認する。

- `lib/runtime/conversation-identity.test.ts` は再開応答の別ID・空IDを拒否し、未送信・対応表維持・診断コードと正常復旧後の再開を確認する。`scripts/verify-single-companion.ts` は実JSON-RPCでも別IDを返し、CLIの失敗とrequestIdによるevents検索、本文未送信、正しいIDへ戻した後の再開を確認する。

- `lib/runtime/runtime-instruction-recovery.test.ts` はCodex接続の復旧時にnativeの指示を再取得し、変更時の新規会話・同じ場合の再開・取得失敗時の未実行・SOULの起動時snapshotを確認する。タイムアウト後に遅れて届いた古い結果も、新しい接続のcontextを上書きしない。
- `scripts/verify-single-companion.ts` は偽Codex子のPIDを取得して終了を観測し、実CLIから復旧する。設定読取・thread/start/resumeの実JSON-RPCを照合し、指示変更では新しい会話、変更なしでは再開になり、以前の依頼の再送やSOUL再読込を行わないことを確認する。指示を変えるfixtureのファイルは隔離workspace内だけに作る。

- `lib/runtime/runtime-options.test.ts` はbuild後にoptionsの資格情報ストアを差し替えても、選択済みのストアから一度だけ取得することを確認する。資格情報の読取を保留している間にconnectionsの指定を変えても、明示した接続と標準接続の選択を両方向で維持する。

- `lib/events/leuco-event-log.bun-test.ts` は、旧project形式の履歴を実SQLiteに保存し、現在形式のMemory履歴と同じ検索結果になることを確認する。別種別の新しいイベントが20件あっても、type・limit=1・asc/descの組み合わせで該当行を失わない。

- `scripts/verify-event-log-concurrency.ts` は別プロセスのSQLite排他ロックに対する保存履歴の読取も検証する。80msのロックは解除後に取得し、800msのロックは待機予算内にSQLITE_BUSYとして失敗し、解除後に同じ履歴が残ることを確認する。`lib/events/database-cleanup.test.ts` はreadonly接続・設定失敗時のclose・両方の原因の保持を確認する。

- `lib/runtime/slack-diagnostic-log.test.ts` はSlackのwarn/errorが各一件の診断に原因・コードを保持し、テキストは一度だけ配送することを確認する。警告をerrorへ昇格させず、テキスト受信側が失敗した場合は別の障害を残し、元の診断を重ねて保存しない。

- `codex-protocol.test.ts` は非JSON・未知frameの省略境界をまたぐ標準トークン・所有者の秘密・Unicodeを検証し、正常な応答値は変換しないことを確認する。`scripts/verify-noninteractive.ts` の偽Codexからも隔離home専用の合成秘密を非JSON行と未知frameへ含め、実CLIの保存ログとTTY表示に断片が残らないことを照合する。

- `runtime-notification-redaction.test.ts` はparams・通知名・tool metadataの省略境界をまたぐ合成秘密を検証し、deltaはsnapshotすら行わず、item/completedで捨てる結果本文もJSON化しないことを確認する。`scripts/verify-noninteractive.ts` の偽Codexは隔離home内のテスト専用lease tokenを通知へ含め、実CLIの保存履歴にその断片が残らないことを照合する。この注入はfixture専用の環境変数でだけ有効にし、実資格情報を使わない。

- `scripts/verify-noninteractive.ts` は実TTYでforeground daemonを起動し、別CLIから偽Codexの依頼を実行する。端末消去ESC・C1制御文字と合成トークンを含むstderrを与え、端末表示に生の制御文字・秘密が残らず、保存イベントと同じrequestId・levelが読めることを確認する。終了も実CLIから行い、foreground子の終了を待つ。

- `leuco-log-consumer.test.ts` は元の依頼IDと背景ログの未関連状態が受信関数まで渡ることを検証する。`scripts/verify-single-companion.ts` は偽Codexで実行したscheduleのIDを実CLIのeventsから読み、daemon.logの同じ発火行に残ることを照合する。実Slackやモデル推論を呼ばない。

- `runtime-observability.test.ts` は依頼を処理中に別connectorの背景警告と過去依頼の失敗を出し、処理中の依頼へ誤って紐付かないことを検証する。ログ出力先の失敗も過去依頼のIDを保持する。SlackとscheduleのMemory検証では、受信・発火イベントと失敗ログが同じIDで検索できることを確認する。

- `write-cli-error.test.ts` は循環参照・BigInt・例外を投げるtoJSON・Symbolの診断情報でも、元のコード・requestId・OS原因を含む構造化エラーへ復旧することを確認する。toJSONで隠れた実行済み情報も失わない。`scripts/verify-noninteractive.ts` では実BunのJSON・YAML両方の結果を公開errorSchemaで検証する。

- `write-cli-error.test.ts` と `request-daemon.test.ts` は転送されたエラーコード、変更前の明示、実行・完了・journal保存の情報を照合する。`scripts/verify-cli-contract.ts` は制御サーバーが受付markerを書いた後にSTATE_CONFLICTを返す実CLI経路を検証し、変更可能性がtrue、markerが各呼び出し一回だけ、変更前の明示的な拒否はfalseになることを確認する。

- `lib/daemon/create-daemon-startup-error.test.ts` はログ末尾の境界にある絵文字の非分断、マスク後の文字数での省略判定、非省略・読み取り失敗の区別をMemory境界で検証する。起動失敗のPID・終了原因も維持する。

- `scripts/verify-cli-contract.ts` はSQLiteへ依頼拒否・supervisor失敗・Codex復旧失敗・再起動failed/uncertain・Slackエラーを保存し、後続の25件の復帰警告と150件の通知に埋もれず実CLIのdoctorへ出ることを確認する。復旧成功・キャンセルは失敗一覧へ混ぜず、警告はeventsのsummaryから読めることも検査する。

- `scripts/verify-noninteractive.ts` はC1制御文字全域とUnicode行区切りをキー・配列・改行のある値へ含め、JSON・YAMLの直接整形、成功結果、エラーを検証する。生の制御文字を出さず、秘密のマスクと読み戻した値を保ち、通常のYAML表示を変えないことを確認する。

- `lib/events/event-log-close.test.ts` はMemory境界で保存先のclose失敗を再現し、失敗の伝播、closedの確定、マスクの保持、原因列のコピーと履歴保持、再試行と成功後の冪等性を検査する。Bun側では実SQLiteの通常終了・再読込・冪等性を検証する。

- `scripts/verify-maintenance.ts` は処理中のturnと、本文を完了しない認証済みmultipart接続を同時に保持して再起動する。control.pendingRequestsで受信中を確認し、旧PID終了・新PIDのready・操作IDに紐付く強制drain警告・中断リクエストIDに紐付くエラー保存を検査する。Runtimeの単体では、借用ログが通常停止・起動失敗後も使え、内部で作ったログは閉じることを確認する。

- Codexの途中状態は単体で診断方針を確認し、`scripts/verify-reliability.ts` の実Unix socketへstarting・stopping・cleaningUpを返すfixtureでもdoctor・repairを実行する。未健全として案内しつつ、再起動endpointが一度も呼ばれないことを検査する。

- `scripts/verify-diagnostic-output.ts`：追記・Unicode・呼び出し元のstderrの継続利用を確認する。ここでの保持は、呼び出し元のstderrを閉じず、追記順序とUTF-8本文を維持することを指す。macOSの通常ファイルでは、Bun FileSinkの利用後に共有fdへO_NONBLOCKが付くことを実機確認している。POSIXでは、満杯にして誰も読まないFIFOへ予備出力を行い、観測期限・追加書き込みのEBUSY・明示的なprocess.exitや強制終了なしの子プロセス終了を検査する。FIFO検証はWindowsでは実行しない。

- 同じscriptで実CLIの閉じたstdout・stderr、1MiBの出力を保持したまま残留タイマーを待たずに終了することを確認する。POSIXの満杯の出力先では、versionと設定変更が終了コード5を返し、変更済みの設定を保持してmutationMayHaveOccurred:trueを示すことも検査する。

- Slack入力源の単体検証は、ログcallbackとstderrが同時に投げる場合、非同期の拒否、原因列のマスクとコピー、遅れた成功通知と復旧を確認する。`scripts/verify-reliability.ts` は実Unix socket経由のstatus・doctorで配送異常と原因コードを読み出し、復旧後も過去の原因を保持することを確認する。

- `scripts/verify-slack-sockets.ts`：実際のFlumeとBun WebSocketをループバックの偽Slackへ接続する。正常な終了応答、応答のないclose、hello待機中の停止、応答しないログcallback、親側でstderrパイプを閉じた実EPIPEを検査し、明示的なprocess.exitなしに子プロセスが終了することを確認する。HTTPは子プロセス内で偽応答に限定し、実Slackへ接続しない。

同期コマンドにもBunのtimeout・killSignal・maxBufferを設定する。package作成・インストール・型検査などは各60秒、リンクとヘルプ確認は各10秒、FIFO作成は5秒。packageとリンクの失敗では終了コード・signalと、マスク・省略した出力を確認する。

- `scripts/verify-packed-package.ts`：配布tarballを独立したBun TypeScript環境へ入れ、宣言ファイルをskipLibCheckで省略せず検査する。Bunの型定義は利用側の開発依存へ明示し、公開APIの型を強制キャストで置き換えない。CLIとメモリ履歴の公開APIも配布物から実行する。

- `lib/cli/cli-deadline.test.ts` と `scripts/verify-cli-contract.ts`：version表示でも重複・競合optionを拒否し、正常なテキスト・YAML・JSONの表示に期限や状態作成を持ち込まないことを確認する。

- `lib/daemon/create-daemon-startup-error.test.ts` と `scripts/verify-storage-cleanup.ts`：起動失敗のログがリンクへ差し替わっても対象を読み出さず、ログ読み取り失敗と子プロセスの原因を別々に保持することを確認する。

- readiness・停止確認の単体検証で実時刻を巻き戻し、経過時間の予算で終了することを確認する。scripts/verify-storage-cleanup.tsは子プロセス内だけDate.nowを固定し、実FSでロック待ちと連続する空チャンクのdownloadが終了することを確認する。親にも強制終了期限を設け、OSの時計は変更しない。
- `lib/daemon/wait-for-daemon-ready.test.ts`：未確認時のstatusと失敗原因の保持、別PIDをreadyとしないこと、確認済み終了の優先、呼び出し元キャンセルを検査する。scripts/verify-cli-contract.tsでも実際の初期化を20秒遅らせ、15秒の起動観測がSTATE_UNCERTAINとready:falseの診断を返すことを確認する。
- `lib/daemon/request-daemon.test.ts`：不正なHTTPエラー本文・過大なJSON応答・キャンセルを無視する読み取り・後片付けの停止・同じ通信所有者による再送拒否を確認する。scripts/verify-cli-contract.tsでも実Unix socketでステータス保持、実際に16MiBを超える応答、ヘッダー後の本文停止を検証する。
- `lib/fs/read-regular-text.test.ts`：FS境界の古いサイズ情報を再現し、実際の読み取りが上限を越えて続かないことを確認する。上限ちょうど・0バイト・分割UTF-8・BOM・無効な上限・読み取りとcloseの両方の失敗も検査する。実ファイルでの分割UTF-8と上限はscripts/verify-storage-cleanup.tsで確認する。
- `lib/runtime/runtime-credentials.test.ts` と `lib/runtime/assert-slack-reply-active.test.ts`：呼び出し元・停止時のキャンセル、requestId付きの原因保持、未確認のSlack停止、遅れて返る応答の期限付き破棄を確認する。停止確認は1500ms、応答破棄は1000ms。CLIの切断はSlack通信へ伝えるが、Slackがすでに受理した書き込みの取り消しは保証しない。
- `scripts/verify-slack-proxy.ts`：実CLIを期限切れにし、Unix socket経由でキャンセルがダウンロード通信へ届き、出力ファイルを作らず、同じrequestIdの履歴へ未確定な外部操作を記録することを確認する。
- `lib/connectors/slack/slack-http-deadlines.test.ts`：Slack APIの通信・本文・応答破棄の期限、HTTPと後片付け両方の原因、upload失敗後の共有なし、失敗した429応答の再試行なしを確認する。期限はHTTP試行ごとで、既存の429再試行は最大一回。タイムアウトは外部で書き込みが受理されなかった保証にはならない。
- `scripts/verify-slack-http.ts`：ネットワークを使わない子プロセスで、停止したfetch・本文・連続する空チャンク・1バイトずつの応答・応答破棄がBunの実タイマーで終了することを確認する。親にも強制終了の期限を設ける。
- `lib/actions/slack/fetch-slack-file.test.ts`：リダイレクト全体の期限、キャンセルを無視するfetch、終了不能な応答、元の原因と後片付けの失敗、最終応答引き渡し後の呼び出し元キャンセルを確認する。
- `lib/actions/slack/assert-slack-file-response.test.ts`：HTTP失敗時の応答破棄を期限付きにし、HTTPステータスを後片付けの失敗で隠さないことを確認する。
- `lib/connectors/slack/flume-close-contract.test.ts`：実際のFlume runtimeとネットワークを使わないsourceで、例外ではなくFlumeClosed.errors()に返る停止失敗を確認する。停止失敗を成功扱いせず、次の接続を重ねて開かない。
- `lib/connectors/slack/leuco-flume-slack-event-source.test.ts`：ソケット終了の確認、停止失敗の保持、同時終了の直列化、watchdogの登録・解除失敗、consumer例外と診断マスクを確認する。
- `lib/runtime/runtime-reliability.test.ts`：初期化が返らない間の停止、全接続の後片付け、元の原因と後片付けの失敗、ログconsumerの例外を確認する。
- `lib/runtime/runtime.test.ts`：直列実行、件数・容量制限、idle・hard timeout、停止後の遅延応答、会話の再開境界を確認する。
- `lib/runtime/inspect-runtime-health.test.ts`：接続・保存の異常と、一時的な再接続・起動中を区別する。
- `lib/connectors/schedule/schedule-no-replay.test.ts`：失敗した単発予定を再起動後に再送しないことと、受付が実行前に保存されることを確認する。
- `lib/runtime/schedule-cleanup.test.ts`：単発予定の実行中、削除の更新処理直前に日時変更やcron化が保存されても新しい予定を残す。本番のstore adapterを通し、変更後の予定の実行と削除／継続も確認する。
- `lib/runtime/schedule-retimed-attempt.test.ts`：古い受付時刻より前でも、対象日時が変わった単発・cronからの切り替えを別の依頼として再起動後に実行する。同じ瞬間の表記変更では再実行せず、実行後の再確認でも重複しない。
- `lib/runtime/schedule-retimed-cron.test.ts`：定期予定の式変更・単発からの切り替えで、古い受付や確認位置を使って新しい式の過去分を実行しない。再起動、未実行の旧式、新しい式を確認後のチェック欠落も検証し、通常の実行と重複抑制を維持する。
- `lib/runtime/schedule-clock.test.ts`：先行する依頼を待つ間の分境界、時計の逆行、cronの取りこぼしを確認する。受付記録のないcronも、そのtickの開始分からの待機中に迎えた時刻を一度実行し、同じ分の再確認で重複しない。
- `lib/runtime/schedule-first-occurrence.test.ts`：初回のcron時刻をまたいでチェックが飛んでも、同じ稼働中に確認済みの予定は一度実行する。新規ID・停止再開では未確認の過去へ遡らず、翌日の通常の取りこぼし確認も維持する。
- `lib/runtime/schedule-refresh.test.ts`：先行する予定の実行中に、後続予定の削除・無効化・延期・本文編集を行う。単発とcronの両方で、古い予定の実行・受付記録を残さず、本文は最新設定を使うことを確認する。先行する依頼が失敗した場合の再読込と、1,000件の実行対象がない予定で設定の読込回数が増えないことも確認する。
- `lib/events/event-health.test.ts`：保存・シリアライズの失敗、回復、マスク、text fallback、外部からの診断値の書き換えを確認する。
- `scripts/verify-reliability.ts`：実Codex互換の偽プロセスを5回強制終了し、daemonの継続・次の依頼での回復・再送なしを確認する。実SQLiteロック、壊れたDB、未処理例外・Promise失敗、同時初期化・停止、notification consumerの例外も確認する。
- `scripts/verify-maintenance.ts`：処理中の再起動、重複受付、起動失敗、古い制御情報、安全な状態再作成、起動識別情報の変更、新しい操作を古いworkerが上書きしないことを確認する。
- `scripts/verify-clipboard.ts`：隔離したOS補助コマンドで、クリップボード登録、サイズ・時間制限、読み取り失敗、値の非表示、失敗時の保存なしを確認する。
- `scripts/verify-linked-cli.ts`：隔離したBunの登録先で、bun linkが現在のソースをleucoコマンドとして公開することを確認する。
- `scripts/verify-noninteractive.ts`：TTYと開いたpipeでも入力を受け付けないこと、期限、YAML / JSON、依頼IDの相関を確認する。

全体の入口は `bun run verify`。検証scriptも型検査し、生成help・ドキュメント・配布packageの契約を検査する。coverageは補助指標であり、障害の再現と回復を示す代わりにはしない。

実Slackへの送信、実モデルの推論、Windows実機、OSサービス管理による自動起動はこの障害注入の対象外。外部サービスの障害やOSの終了を含め、絶対に停止しないこと・すべてのバグがないことを保証するものではない。

## 大量ログのローカル観測

2026-10-30、Bun 1.4.4で合成ログ `"xoxb-a "` を100万回並べ、7,000,000文字の入力から11,000,000文字の期待結果へ全件一致することを確認した。時間はマスクと結果照合、RSSは照合後のプロセス観測値。

| 条件                                                         | 処理・照合時間 | 終了時RSS |
| ------------------------------------------------------------ | -------------: | --------: |
| 標準のSlack形式だけが一致                                    |          107ms |   約95MiB |
| 登録値 `xoxb-` も100万箇所で重なり、置換語 `redacted` も登録 |          243ms |   約77MiB |

一致候補は各matcherのiteratorから順に取り出し、重なる範囲をまとめる。全一致の配列を先に作らない。元の文字列だけを照合するため、出力したマーカーを新しい一致として処理しない。

## 実環境の確認方法と過去の記録

2026-10-29にmacOS、Bun 1.4.4、codex-cli 0.163.0で通常のCODEX_HOMEを引き継ぐ一回実行を確認し、実モデルから指定した確認文字列LEUCO_OKが返った。偽Codexによる検証とは区別する。

Slackの実接続は、人が各トークンを一つずつコピーして登録してから確認する。テスト用の補助コマンドとMemory資格情報ストアでの登録検証を、実Slack認証の成功とみなさない。デスクトップ補助コマンドのnative fixtureはmacOS/Linux用で、Windowsでは実クリップボードを誤って読まないよう明示的に停止する。

資格情報登録後の実Slack確認は `bun run scripts/verify-live-slack.ts` を明示的に実行する。auth.testとSocket Mode接続を確認して切断し、受信内容からagentを起動せずSlackへ投稿しない。通常のverifyには含めない。

## 改修時の確認記録

`handle-daemon-request.test.ts`はmodel・agent・instructions・codexBinを含むturnを実行前に拒否し、長い未知項目名へ埋めた制御credentialが応答に残らないことを確認する。`get-bounded-validation-issues.test.ts`も既知の秘密がpath/messageの短縮位置を跨ぐ場合と元のError不変を確認する。修正前はこの6ケースが失敗した。`verify-cli-contract.ts`では実daemonとrequestDaemonを通しても未対応modelがUSAGE/変更なしになることを確認する。

`handle-daemon-request.test.ts`は空白入力の4通りにUSAGE・validation・executionStarted=falseとtextのissuesを付け、callbackを呼ばないことを確認する。修正前は4件とも情報が欠けて失敗した。callbackがUSAGEを返す／throwする2通りは実行前扱いにならない。`verify-cli-contract.ts`は実daemonへ不正なturnを送り、requestDaemonを通してもUSAGE・該当項目・mutationMayHaveOccurred=falseが保持されることを確認する。

空文字・半角空白・改行tab・全角空白について、CLI、制御API、SDK、予定の各入口で拒否することを確認する。修正前はCLI・SDK・予定の検証10件が失敗した。RuntimeではCodexのturn・thread作成・queue変更がなく、意味のあるSDK本文と予定promptは空白・改行を保持する。`verify-cli-contract.ts`でも空白のaskと予定作成を副作用なしのUSAGEとして確認する。

LEUCO_HOMEを空文字にして隔離した実CLIで設定を保存すると、修正前は作業場所にsettings.jsonが作られた。修正後はUSAGEで拒否する。`verify-cli-contract.ts`は同じ入力でファイル一覧・ディレクトリ権限が変わらず、help/versionは表示できることを確認する。`runtime-home.test.ts`は明示的なhomeと環境変数の両方で空文字を設定読込前に拒否し、有効な明示homeの優先順位を保持することを確認する。

`verify-reliability.ts`はSQLiteの実書込失敗と回復の後、doctorのhealthy=trueを維持しつつ、履歴欠落の可能性と調査先をhintsで案内することを確認する。修正前はこの案内がなく失敗した。書込失敗前は、過去のCodex失敗が残っていても同じ案内が出ないことを確認する。

`repair-runtime.test.ts`はバックアップの同期失敗、close失敗、両方の失敗を注入し、元の状態を置き換えずcloseと予約解除を行い、EIO・EBUSYを保持することを確認する。成功時も同期・closeより前に空状態を保存しない。修正前は新しい4ケースが失敗した。実FSのバックアップ完全一致・0600・並行更新の保護は`verify-storage-cleanup.ts`で引き続き確認する。

`run-cli-reservation.test.ts`と`repair-runtime.test.ts`は中止済みsignalを渡した設定保存・予定追加・会話リセット・資格情報操作・状態復旧の6ケースで、元の中止理由を返し、書込・資格情報操作・予約解除・成功出力へ進まないことを確認する。修正前は6件とも失敗した。`verify-storage-cleanup.ts`は隔離した実FSで設定保存と会話リセットがホームを作らず、復旧が破損状態の元byte列とファイル一覧を変えないことを確認する。

`repair-runtime.test.ts`は最初の破損判定後、state.lock取得時に状態が正常化した場合、バックアップ・空状態の保存をせずSTATE_CONFLICT/phase=state-resetで終え、予約を解除することを確認する。修正前は保存が呼ばれ失敗した。`verify-storage-cleanup.ts`は実際の別プロセスでstate.lockを保持し、repairの予約を確認してから会話と実行記録を保存する。repairがその書込後に状態を再確認し、両方を保持して不要なバックアップを作らないことを確認する。

`verify-storage-cleanup.ts`は不正・途中で切れたUTF-8を含む状態を明示的に復旧し、作成したバックアップが元のbyte列に完全一致して0600であることを確認する。修正前はUTF-8の置換文字へ変わり失敗した。`read-regular-text.test.ts`は同じbyte列を短いreadで読み、元のまま返してcloseすること、既存のBOM・多バイト文字・不完全な末尾の通常テキスト表示が変わらないことを確認する。復旧のunitはバイト読込境界をMemory化し、バックアップ保存失敗と予約解除失敗の両原因を保持する。

存在しない予定を隔離した実CLIで削除すると、修正前はUSAGE/mutationMayHaveOccurred=falseにもかかわらず空のホームを作成した。修正後はホームなしのまま終了する。`manage-settings.test.ts`は不在・曖昧な対象でupdateSettingsを呼ばないことと、書込直前に対象が消えた場合の再照合・並行変更の保持を確認する。`verify-cli-contract.ts`も未作成ホームへの削除を入力エラーの副作用検証に含める。

`manage-settings.test.ts`はtimezone・timeZone・repeat・threadを予定へ指定した4通りについて、USAGE・予定のindex・未対応項目名を返し、updateSettingsを呼ばず既存設定を保持することを確認する。修正前は4件とも成功して項目を削除していた。`verify-cli-contract.ts`は実CLIでtimezone付きの予定を拒否し、ホーム未作成時の副作用なしと既存settings.jsonのbyte単位の不変を確認する。

`schedule-failure-diagnostics.test.ts`の予定名を、秘密文字列が省略位置を跨ぐ長さへ拡張したところ、修正前は8通りともログ全体の上限または保存行との一致で失敗した。修正後は発火・失敗・削除待ちのcallback本文全体が4000文字以内で、原因コードとrequestIdを維持する。予定名を省略しても秘密の断片を残さないよう、全体を秘匿してから制限する。

`schedule-diagnostic-log.test.ts`はRuntimeとMemory境界で、予定の読込失敗が原因付きの1イベントと1回のテキスト出力になることを確認する。出力先が失敗しても元のEACCESを保持し、logConsumerの不健全と実行なしを確認する。修正前は2件とも重複した履歴で失敗した。`schedule-failure-diagnostics.test.ts`は読込・実行前保存・turn・削除の失敗について、onTextLogあり／なしの8通りで巨大本文の制限、秘密情報の除去、原因コード、turnのrequestId一致、元のError不変を確認する。

`cli-integer-boundaries.test.ts`はeventsのsinceについて、通常・構造化helpの上限、0と最大安全整数の受理、負数・小数・指数表記・精度を失う整数の拒否を確認する。修正前はエラーの上限がundefinedになり9件中7件が失敗し、カタログへ既存の実効上限を明示した後は9件が成功する。

2026-10-29の改修確認では、全体のverify、単体366件、SQLite 8件、CLI・障害注入・配布・bun linkの検証が通過した。通常のCodex環境を使った実モデルとの往復も確認済み。

その後、BotとAppのトークンをそれぞれクリップボードから登録し、実Slackの認証とSocket Mode接続を確認した。常駐起動後、利用者がSlackへの実際の返信も確認した。接続検証scriptは確認後に切断するため、それだけではBotは常駐しない。

実利用で判明した停止中の正常誤判定と、返信用CLIの未登録を見逃す問題をdoctorで修正した。停止中はCHECK_FAILEDと起動案内を返し、Slack設定時に呼び出し元のPATHでleucoが見つからない場合はbun linkとPATH設定・再起動を案内する。隔離したCLI検証で停止中・CLI未登録・登録後の判定を再現する。

実BotへのCLI依頼でも、Bot自身がstatusとdoctorを実行し、Codex稼働・Slack接続・SQLiteとテキストログ保存の正常を確認した。この診断依頼はSlackへ投稿しない。

続く確認で、制御情報破損時も停止中と案内していた問題を修正し、稼働不明と状態リセット不可を返すようにした。起動中の終了はstartのエラーから子PID・終了コード・signal・マスク済み直近ログを直接調べられる。実CLI検証で、修正前の誤判定と原因不足を再現し、修正後の情報・ログ長制限・トークン形式のマスクを確認する。

実Botの過去の正常終了には停止受付の理由がなく、きっかけを断定できなかった。今後は停止理由をログへ残し、制御リクエストはrequestIdを引き継ぐ。隔離CLIで停止依頼の相関と実SIGTERM後の理由保存を確認する。SIGKILLや電源断のように記録できない終了とは区別する。

ログの可読性の確認で、Codexの構造化WARN / ERRORがinfoへ変わり、stderrの受信断片が別の行として保存される問題を修正した。重要度の判定はCodexの構造化stderr境界に限定し、任意の受信本文から推測しない。単体で分割行・最終行・長文の上限と復帰を検査し、隔離した実プロセスでも分割した疑似トークンがマスクされ、warnとして保存されることを確認する。

events --summaryは内部通知とinfoログを読み出し時に除外する。SQLiteではSQLの件数制限より前に、メモリ履歴では配列の件数制限より前に絞り込む。実CLIで大量の通知後も重要イベントを取得でき、壊れたDBによるメモリ履歴でも同じ規則になることを確認する。

診断も件数制限の前に失敗を検索し、大量の通知後に失敗履歴を見失わないようにした。キャンセルは除外する。SOULのファイル種別・読み取り・サイズとCodexの実行可否も確認する。ディレクトリ指定を正常扱いしていた修正前の失敗を実CLIで再現した。設定・起動環境・制御・履歴の診断を分け、Memory境界でも各設定の読み取り失敗を独立して保持することを検査する。

前面実行と停止確認はCLIの出力・振り分けから分けた。startが先頭の引数をcommandと決めつけ、先に置いた--cwdを失う問題も修正した。隔離したCLIでoptionを前後へ置いて同じ実行先になることを確認する。

履歴の読み出しでは、ライブ側の取得失敗を保存済み履歴の成功で隠していた問題を再現した。現在は部分履歴をSTATE_UNCERTAINのdetailsへ残し、原因と不足の可能性を示す。隔離した制御サーバーで、メモリ履歴の拒否・制御の拒否・応答停止を確認し、保存済み履歴が短い期限で読めることを検査する。予定の重複と不正日時も入力エラーに分類し、実CLIとMemory設定で保存前の拒否と既存設定の保持を確認する。

同じ隔離サーバーで不正なイベント応答とSQLiteファイルの消失も再現し、空履歴や不正形式を成功として返さないことを検査する。通信エラーをCliErrorへ変換するときは元のErrorをcauseでも保持する。タイムアウトをさらに診断エラーへ包んでも、causesに元のエラー種別が残ることを実プロセスで確認する。

保存と後片付けの確認では、ロック解除の権限エラーが成功扱いになること、元のエラーと解除エラーの片方が失われること、FIFOロックの読み取りが停止すること、undefinedを既存JSONへ書いてしまうことを隔離した実FSで再現した。scripts/verify-storage-cleanup.tsで権限変更とFIFOを検査し、停止した子プロセスは親から期限付きで終了させる。処理と後片付けの結果は同期用の共通関数で保持し、ファイルを開く前にJSON化できることも確認する。

資格情報では、設定保存後の失敗を保存前と誤認して参照中の秘密を削除する問題と、ログアウト設定の保存前に秘密を削除する問題をMemory実装で再現した。保存済み参照を再確認してから巻き戻し、参照を確認できない場合は保持する。ログアウトは無効化を先に保存する。OS側の後片付けに失敗した場合も参照IDと原因を残す。実トークン・実クリップボードはこの検証では読み書きしない。

ダウンロードでは、応答・読み取り・キャンセルがAbortSignalを無視すると期限後も返らないことと、一時ファイル削除の権限エラーが隠れることを再現した。文字列チャンクをバイト列と誤認して保存先を空ファイルへ置き換える問題、空チャンクの連続でタイマーを動かせず処理が止まる問題も再現した。転送の所有者を一つにまとめ、待ちの中断・期限付きの後片付け・公開前のキャンセル確認を行う。

scripts/verify-storage-cleanup.tsは停止し得る各ケースを期限付きの子プロセスで実行する。修正前は親による強制終了が必要だった各待ちが修正後は戻り、既存保存先を保持することを確認する。削除権限の変更では元の転送エラーとEACCES / EPERMが残ることを検査する。正常なUTF-8・空チャンクを含む転送・0600の保存も確認し、純粋な期限処理は実FSを使わない単体で検査する。

## 試験プロセスの後片付け

verify-reliability.tsは起動した全ての隔離ホームを追跡し、試験の成否にかかわらずdaemonの停止を確認してから作業ディレクトリを削除する。確認できない場合は元の試験失敗と後片付けの原因を併記し、調査用のディレクトリを保持する。

`LEUCO_VERIFY_FAIL_AFTER_DEGRADED_START=1 bun run scripts/verify-reliability.ts` で、異常系daemonの起動直後に意図的な失敗を入れられる。終了コード1とInjected fixture cleanup failureを確認し、メッセージに出た隔離ホームの親ディレクトリと、そのパスを使うプロセスが残っていないことを検査する。通常の製品CLIにはこの試験用設定を渡さない。

メンテナンスの補助イベント保存は、壊れたDBと閉じたstderrを組み合わせた子プロセスで検査する。通常の戻り値に加えてプロセスの終了コード0とjournalのSQLITE_NOTADBを確認し、終了直前の非同期EPIPEを成功と見誤らない。保存・close・注記の複合障害と、別operationへの所有権移動はMemory境界の単体で確認する。

HTTP状態だけで実行前の拒否と判定しないことを、実行後に503を返す偽Slack callbackで検査する。実CLIの終了コード5・mutationMayHaveOccurred:trueと、受付記録が一度だけ残ることを確認する。実行前のreadiness拒否は終了コード3・executionStarted:falseで区別し、本文が不正な503はphase=error-bodyとして未確認にする。

所有情報の取得はMemory境界の単体で準備失敗・既存の生きた所有者・公開失敗を確認する。実FSではcontrol.sockをディレクトリにした隔離ホームで取得を失敗させ、daemon.jsonが公開されず、実CLIのstatusもrunning:falseを返すことを検査する。問題のディレクトリを再帰的に削除して回避しない。

所有解除の検証では、同じtokenでPIDだけが変わった場合も所有情報と制御パスを保持する。実FS上で完了済みの操作後に所有者を変え、予約付き処理が成功を返さずoperationCompleted:trueの未確認となることを検査する。古い所有スナップショットからの再起動も、maintenance.jsonを作らず拒否する。通常の停止・復旧は全体の実プロセス検証で確認する。

stderrの上限で絵文字や秘密が分断されるケースと、省略後の別チャンクが混ざるケースを単体で検査する。上限超過行は本文なしの診断になり、上限に収まる絵文字はそのまま保持する。隔離したfake Codexの実stderrでも同じ境界を作り、保存イベントとforeground出力に分断されたサロゲートや合成した制御トークンの先頭部分が残らず、省略情報が記録されることを確認する。

通知のmethod名・完了メタデータの256文字境界と、JSON previewの算出した境界へ絵文字を置き、分断せず省略することを単体で確認する。previewCharsが保持済み文字列の長さと一致することも検査する。既知の秘密を省略前にマスクする回帰試験も併せて実行する。

Runtimeの起動・turn、scheduleの保存判断、SlackのError付き／本文だけの障害へ長いメッセージを注入し、lastFailureの4,000文字上限と省略前のマスクを単体で確認する。元のErrorとイベントの原因コードも確認する。偽Codexの実turn失敗でも、statusのメッセージに省略マーカーが残り、隔離homeの合成制御トークンが出ないことを実CLIで検査する。

実プロセスのPIDを所有情報へ記録して再起動を受け付けた直後に、隔離homeの所有ファイルを削除／停止済みPIDへ差し替える。workerの終了・uncertain・newPidなしを確認し、同じhomeへのrestart再試行・start・repairでも置き換えが起動せず、journalと差し替えた所有情報が保持されることを検査する。実CodexやSlackは起動しない。oldPid/newPidと自己PIDの扱いは共通判定の単体で確認する。

所有情報が消失／停止済みPIDへ変わった実FSの再起動試験で、statusとstopが終了コード5・phase=identityを返し、stopがexecutionStarted:falseとなることを検査する。doctorに生存PID・running:null・ownership:unknownが残り、staleLeaseや状態リセット可能を返さないことも確認する。oldPid/newPidと不在／古いleaseの4通りはMemory境界の単体で確認し、未認証のcontrol要求が送られないことを検査する。

主エラーへ17MiBの合成文字列と途中のSlack形式を渡し、修正前のjournal書き込み上限エラーを再現する。Memoryで新規保存・既存ID更新を確認し、実FSでもjournalとイベントに同じ4,000文字以内のマスク済みエラーが残り、実CLIのstatusから原因コードを読めることを検査する。直前に英字・アンダースコアが続くBot/Appトークン形式のマスクも単体で確認する。実トークンは使わない。

Socket Mode形式の合成接続URLを使い、ws/wss・大文字プロトコル、引用符入りJSON、クエリなしURLを単体で確認する。偽Codexのstderrにも同じURLを送り、foreground表示と保存イベントに接続先が残り、合成ticketが出ないことを実CLIで検査する。実トークンや実接続URLはfixtureへ持ち込まない。

メモリ履歴の読み出し後にseq・nested params・runtime.getVolatileEventsの本文やrequestIdを変更し、次の取得では原記録が保たれることを確認する。登録前に保存した合成秘密も、登録後の読み出しで伏せる。実SQLiteへ旧形式の接続URLを直接保存し、ライブラリ読み出しのマスクと、原記録が書き換わらないことを実FSで照合する。

同じオブジェクトを返すCodex portと接続アダプターを注入し、getStatusのready・nested lastFailureの変更が提供元へ伝わらず、提供元の後続更新も取得済み状態へ伝わらないことをMemory境界で確認する。

ローカル制御のtransport失敗・不正なJSON本文・呼び出し元キャンセルへ、経路・method・lease PID・予算・elapsed・中断状態が残ることを単体で確認する。実HTTPで本文待ちを200msで中断した診断と、eventsの上位エラーへ包んだ接続待ち失敗の経路／予算を検査する。クエリ・本文・制御tokenが診断へ入らないことも確認する。

応答待ちの間に呼び出し元がpath・homeを書き換えても、/statusの別PID応答を拒否することを確認する。期限・bodyの有無・signal参照の書換えでも元の通信条件とキャンセル状態が診断に残ること、生成後のexpectedLease変更が当該リクエストの所有者基準へ伝わらないことも単体で検査する。

Date.parseが受け付ける年・日付のみ、zoneなし、非閏年2月29日・4月31日を新規作成で拒否する。UTC・offset、分精度・小数秒・小文字区切り・コンパクトoffset・24:00と有効な閏日を確認する。一括configの新規／retimeでも保存前にUSAGEとなり、既存の曖昧な日時を保持したprompt編集は可能なことをMemoryで確認する。実CLIでも新規と一括設定を拒否し、状態ファイルが作られないことを検査する。

- `codex-pending-notifications.test.ts` は順序・スナップショット所有・件数とUTF-8容量の上限・解放後の再利用を検証する。`verify-single-companion.ts` は実JSON-RPCで受付前に少量通知・1,001件・大容量通知を送り、通常の成功と超過時の失敗、変更の可能性、後続の明示依頼による復旧、再送なしを確認する。

- `codex-protocol.test.ts` は承認要求の長い要求名・ID、改行・端末制御文字・合成秘密を使い、拒否ログが一行・容量制限・マスクを保ち、返答のIDと-32601を維持することを確認する。

- `verify-reliability.ts` はCodexクライアント生成後に元のargs・env・onLogを個別に書き換え、隔離した偽Codexの2回の起動で当初の実行ファイル・環境・ログ関数を維持することを検証する。

- `is-codex-thread-missing-error.test.ts` はエラーの発生元・code・対象IDを照合し、モデル・資格情報・曖昧なエラーで会話を破棄しないことを確認する。`verify-single-companion.ts` は実JSON-RPCのmodel not foundでCLIが失敗し、対応表・thread/start・turn/startを変更しないこと、明示的な後続依頼で元の会話を再開すること、対象IDのrollout消失だけ新規会話へ切り替えて一度だけ実行することを確認する。

- `conversation-recovery-log.test.ts` は履歴消失・不正の回復時に警告を一件だけ残し、元のthread ID・理由・requestId・マスク済みの原因コードを確認する。新しい会話で依頼を一度だけ実行することも照合する。

- `runtime-failure-redaction.test.ts` はmessage・stack・name・codeの各省略境界に合成秘密を置き、root・nested causeの8ケースでturn.errorへ断片が残らないこと、原因の数と容量制限、元のErrorの返却、後続の明示依頼による復旧を確認する。

- `runtime-failure-redaction.test.ts` は10万文字の失敗で元のErrorを返しつつ保存本文を4,000文字以内へ抑え、statusとcausesの本文が一致して原因コードを保持することを確認する。`verify-noninteractive.ts` は巨大な失敗を実JSON-RPCで受けた後、SQLiteから直接読み出した本文にも同じ上限が適用されることを確認する。

- `codex-turn-text.test.ts` はdelta・旧形式・明示phase・final_answerの選択順、空の完了本文、UTF-8容量と断片数の上限、解放後の再利用を確認する。`verify-single-companion.ts` は実JSON-RPCで大量delta・巨大final_answer・巨大旧形式本文・空の完了本文1万件超を送り、原因付きの失敗・変更の可能性・後続の明示依頼による復旧と再送なしを確認する。

- `schedule-state-reads.test.ts` は対象のないcron1,000件でloadStateが各tick一回で済むこと、tick間と先行turnの待機中の記録更新を取り込んで後続予定を二重実行しないことを確認する。

- `verify-single-companion.ts` は実JSON-RPCのモデル参照失敗を起こし、CLIのrequestIdで取得したturn.errorにCodexRpcErrorのcode=-32600（診断上は文字列）が残ることを確認する。

- `is-codex-history-corruption-error.test.ts` は同じ履歴validation文言でもローカル・内部・429・表示本文の改変では置き換え対象にしないことを確認する。`verify-single-companion.ts` は同じ文言の-32603と-32600を実JSON-RPCで送り、前者で対応表と未送信の依頼を保ち、明示回復後に同じ会話を再開し、後者だけ新規会話で一度実行することを確認する。

- `inspect-runtime-health.test.ts` はscheduleだけのerrorでは再起動を勧めず、独立したCodex・Slack障害を隠さないことを確認する。`verify-reliability.ts` は実CLIのdoctorが予定のエラーを返し、repairが/restartを呼ばず、状態回復後のdoctorが正常へ戻ることを確認する。

- `schedule-cleanup-clock.test.ts` はturn待機中に時計を前後2分動かしてから削除を失敗させ、失敗直後には削除を再試行せず、60秒後に削除だけを行いturnが一度であることを確認する。

  同テストで、再試行待ちのtickでもstate=errorと元の失敗が残り、削除成功でreadyへ戻ることを確認する。修正前は一覧の読込だけでreadyへ戻り2件とも失敗した。statusのテストは待機中の健全性判定がhealthy=false/restartRecommended=falseであること、lastFailure snapshotの変更が内部へ届かないこと、対象の削除・無効化・時刻変更後に失敗表示も解放されることを確認する。

- `schedule-cleanup-status.test.ts` は削除失敗後のpending/nextRetryAt、返したstatusの変更による内部汚染なし、削除・無効化・日時変更後の古い待機の解放とdurable記録・一度限りの実行を確認する。時計のテストは削除回復後のpending=0も確認し、`verify-single-companion.ts` は実daemonのstatusへcleanupが届くことを確認する。

- `schedule-cleanup-status.test.ts` は別の予定のturnを待つ間に後続のcleanup対象を削除・無効化・日時変更し、同じtick内の再読込で待機表示が消え、後続の削除・依頼の再送・durable記録の消去が起きないことを確認する。
