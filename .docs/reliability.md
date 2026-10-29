# 障害時の設計と検証

一つのCodex、一つの待ち行列、通常のCODEX_HOMEを維持する。独自のagent管理や、壊れた状態を隠して成功扱いする復旧層は足さない。

## 継続・停止・再試行の境界

- Codexが処理中に終了した場合、その依頼を失敗として記録し、次の依頼で接続を作り直す。依頼の再送はしない。
- cron・単発とも受付を実行前に保存する。応答が不明でもその回を再送しない。受付後の電源断では未実行になる可能性がある。外部APIとローカル状態をまたぐ完全な一回限りの実行は保証しない。
- Slackの一時的な切断はFlumeの再接続で扱い、状態を隠さない。再接続中と、接続不能・設定の読み込み失敗を診断で区別する。
- ログDBが利用不能なら元のDBを保存し、最大1000件のメモリ履歴と容量制限付きのテキストログで継続する。保存失敗を健全と表示しない。メモリ履歴は停止で失われる。
- 未処理例外・Promise失敗は原因を記録して終了処理へ進む。CLI起動のBotは独立workerで復旧するが、60秒内3回までとし再起動ループを止める。ライブラリの呼び出し元は勝手に再起動しない。壊れた状態のまま正常稼働を装わない。OS停止・強制終了・電源断からの常駐管理はOS側の責任とする。
- 終了を確認できないプロセスの所有情報は保持する。再起動は受付後の独立workerで行い、進行を確認できない場合はuncertainとする。

## 調査の入口

`leuco --help` を入口に、`doctor`、`status`、`events --request <requestId>`、`logs` を使う。requestIdはCLI・Slack・予定からCodexの実行結果まで引き継ぐ。起動ごとのinstanceIdとCodex PIDで、別の起動のログを混同しない。

causesには上限付きでエラーコード・スタック・原因の連鎖を残す。元の原因を後片付けの例外で上書きしない。OS資格情報APIだけは秘密が例外文に含まれる可能性があるため、生の文面を出さず安全なOSエラーコードを保持する。

## 回帰の証拠

- `lib/connectors/slack/flume-close-contract.test.ts`：実際のFlume runtimeとネットワークを使わないsourceで、例外ではなくFlumeClosed.errors()に返る停止失敗を確認する。停止失敗を成功扱いせず、次の接続を重ねて開かない。
- `lib/connectors/slack/leuco-flume-slack-event-source.test.ts`：ソケット終了の確認、停止失敗の保持、同時終了の直列化、watchdogの登録・解除失敗、consumer例外と診断マスクを確認する。
- `lib/runtime/runtime-reliability.test.ts`：初期化が返らない間の停止、全接続の後片付け、元の原因と後片付けの失敗、ログconsumerの例外を確認する。
- `lib/runtime/runtime.test.ts`：直列実行、件数・容量制限、idle・hard timeout、停止後の遅延応答、会話の再開境界を確認する。
- `lib/runtime/inspect-runtime-health.test.ts`：接続・保存の異常と、一時的な再接続・起動中を区別する。
- `lib/connectors/schedule/schedule-no-replay.test.ts`：失敗した単発予定を再起動後に再送しないことと、受付が実行前に保存されることを確認する。
- `lib/events/event-health.test.ts`：保存・シリアライズの失敗、回復、マスク、text fallback、外部からの診断値の書き換えを確認する。
- `scripts/verify-reliability.ts`：実Codex互換の偽プロセスを5回強制終了し、daemonの継続・次の依頼での回復・再送なしを確認する。実SQLiteロック、壊れたDB、未処理例外・Promise失敗、同時初期化・停止、notification consumerの例外も確認する。
- `scripts/verify-maintenance.ts`：処理中の再起動、重複受付、起動失敗、古い制御情報、安全な状態再作成、起動識別情報の変更、新しい操作を古いworkerが上書きしないことを確認する。
- `scripts/verify-clipboard.ts`：隔離したOS補助コマンドで、クリップボード登録、サイズ・時間制限、読み取り失敗、値の非表示、失敗時の保存なしを確認する。
- `scripts/verify-linked-cli.ts`：隔離したBunの登録先で、bun linkが現在のソースをleucoコマンドとして公開することを確認する。
- `scripts/verify-noninteractive.ts`：TTYと開いたpipeでも入力を受け付けないこと、期限、YAML / JSON、依頼IDの相関を確認する。

全体の入口は `bun run verify`。検証scriptも型検査し、生成help・ドキュメント・配布packageの契約を検査する。coverageは補助指標であり、障害の再現と回復を示す代わりにはしない。

実Slackへの送信、実モデルの推論、Windows実機、OSサービス管理による自動起動はこの障害注入の対象外。外部サービスの障害やOSの終了を含め、絶対に停止しないこと・すべてのバグがないことを保証するものではない。

## 実環境の確認

2026-10-29にmacOS、Bun 1.4.4、codex-cli 0.163.0で通常のCODEX_HOMEを引き継ぐ一回実行を確認し、実モデルから指定した確認文字列LEUCO_OKが返った。偽Codexによる検証とは区別する。

Slackの実接続は、人が各トークンを一つずつコピーして登録してから確認する。テスト用の補助コマンドとMemory資格情報ストアでの登録検証を、実Slack認証の成功とみなさない。デスクトップ補助コマンドのnative fixtureはmacOS/Linux用で、Windowsでは実クリップボードを誤って読まないよう明示的に停止する。

資格情報登録後の実Slack確認は `bun run scripts/verify-live-slack.ts` を明示的に実行する。auth.testとSocket Mode接続を確認して切断し、受信内容からagentを起動せずSlackへ投稿しない。通常のverifyには含めない。

## 完了確認の状況

2026-10-29の改修確認では、全体のverify、単体366件、SQLite 8件、CLI・障害注入・配布・bun linkの検証が通過した。通常のCodex環境を使った実モデルとの往復も確認済み。

その後、BotとAppのトークンをそれぞれクリップボードから登録し、実Slackの認証とSocket Mode接続を確認した。常駐起動後、利用者がSlackへの実際の返信も確認した。接続検証scriptは確認後に切断するため、それだけではBotは常駐しない。

実利用で判明した停止中の正常誤判定と、返信用CLIの未登録を見逃す問題をdoctorで修正した。停止中はCHECK_FAILEDと起動案内を返し、Slack設定時に呼び出し元のPATHでleucoが見つからない場合はbun linkとPATH設定・再起動を案内する。隔離したCLI検証で停止中・CLI未登録・登録後の判定を再現する。

実BotへのCLI依頼でも、Bot自身がstatusとdoctorを実行し、Codex稼働・Slack接続・SQLiteとテキストログ保存の正常を確認した。この診断依頼はSlackへ投稿しない。

続く確認で、制御情報破損時も停止中と案内していた問題を修正し、稼働不明と状態リセット不可を返すようにした。起動中の終了はstartのエラーから子PID・終了コード・signal・マスク済み直近ログを直接調べられる。実CLI検証で、修正前の誤判定と原因不足を再現し、修正後の情報・ログ長制限・トークン形式のマスクを確認する。

実Botの過去の正常終了には停止受付の理由がなく、きっかけを断定できなかった。今後は停止理由をログへ残し、制御リクエストはrequestIdを引き継ぐ。隔離CLIで停止依頼の相関と実SIGTERM後の理由保存を確認する。SIGKILLや電源断のように記録できない終了とは区別する。
