## ファイル

- ファイル名は主な関数やクラスに合わせ、小文字ケバブケースにする
- import は `@/` 絶対パス、相対パス禁止

## 型

- type のみ、interface と enum 禁止
- unknown のみ、any と as 禁止
- 未指定と明示的な無効化を区別する設定では、undefinedとnullの意味を維持する
- Zod スキーマから `z.infer` で型を生成する

## 命名

- 省略しない。`data` / `result` / `items` など汎用名を避ける
- 配列は複数形、Boolean は `is` / `has` / `can`
- メソッド: `with*()` 変換、`to*()` 出力、`get*()` 取得
- ファイル内に1つだけの Props / Deps 型は `Props` / `Deps` のまま。`ChannelServiceDeps` のようなプレフィックスは付けない
- export して名前空間が衝突する場合のみ長い名前にする

## 関数

- 引数は3個まで、4個以上は `props: Props`

## 変数・制御フロー

- const のみ、destructuring 禁止
- for-of、early return、if を使う（switch 禁止。ただし Reducer の Action 分岐は exhaustive switch）

## ports と Memory 実装

- 外部境界（FS / HTTP / process / clock / id / Slack / codex 等）は新規追加時に **abstract class + Node 実装 + Memory 実装** で並置する
- 既存の `*Port` 型 alias は段階的に abstract class に寄せる。Memory 実装は別ファイル（`*-memory-*.ts`）に置き、テストでは Node 実装ではなく Memory 実装に依存する
- 抽象 class はメソッドシグネチャだけ。状態を持つのは Node / Memory 実装側
- テストは実 FS / spawn / fetch / WebSocket に触れない。tmpdir でしか書けないものは抽象化が漏れているサイン

## コメント

- 動作が予測しにくい場合のみ。@param, @return 禁止
