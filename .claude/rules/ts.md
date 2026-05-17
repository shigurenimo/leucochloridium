## ファイル

- 1ファイル1関数 or 1クラス。ファイル名 = 関数名/クラス名（小文字ケバブケース）
- import は `@/` 絶対パス、相対パス禁止

## 型

- type のみ、interface と enum 禁止
- unknown のみ、any と as 禁止
- `as unknown as T` は最終手段のみ。使いたくなったら手を止めて根本原因を調べる
- 値がないことは null（空文字や optional でなく `string | null`）
- Zod スキーマから `z.infer` で型を生成する

## 命名

- 省略しない。`data` / `result` / `items` など汎用名を避ける
- 配列は複数形、Boolean は `is` / `has` / `can`
- メソッド: `with*()` 変換、`to*()` 出力、`get*()` 取得
- ファイル内に1つだけの Props / Deps 型は `Props` / `Deps` のまま。`ChannelServiceDeps` のようなプレフィックスは付けない
- export して名前空間が衝突する場合のみ長い名前にする

## 関数

- 引数は3個まで、4個以上は `props: Props`
- 20行以内、純粋関数を優先

## クラス

- `constructor(private readonly props: Props)` + `Object.freeze(this)`
- `with*()` で不変更新、配列は ReadonlyArray

## 変数・制御フロー

- const のみ、destructuring 禁止
- for-of、early return、if を使う（switch 禁止。ただし Reducer の Action 分岐は exhaustive switch）

## ports と Memory 実装

- 外部境界（FS / HTTP / process / clock / id / Slack / codex 等）は新規追加時に **abstract class + Node 実装 + Memory 実装** で並置する
- 既存の `*Port` 型 alias は段階的に abstract class に寄せる。Memory 実装は別ファイル（`*-memory-*.ts`）に置き、テストでは Node 実装ではなく Memory 実装に依存する
- 抽象 class はメソッドシグネチャだけ。状態を持つのは Node / Memory 実装側
- テストは実 FS / spawn / fetch / WebSocket に触れない。tmpdir でしか書けないものは抽象化が漏れているサイン

## エラー

- Service / store は throw する。戻り値の union `T | Error` は使わない
- ハンドラに try/catch を書かない。失敗は `throw new HTTPException(status, { message })` に統一し、`lib/cli/routes/index.ts` の onError が `error: <message>` で返す
- `return c.text("...", 4xx)` 禁止
- library 層（logger / boot 等、Hono 非依存の純粋部品）だけは戻り値の Error も許容する

## 空行

- 処理と処理の間に1行の空行を入れる。インデント2段目まで適用、3段目以降は詰める

```ts
export function run() {
  const x = 0

  console.log(x)

  if (x === 0) {
    const y = 1
    console.log(y)
  }
}
```

## コメント

- 動作が予測しにくい場合のみ。@param, @return 禁止
