## コンポーネント

- `type Props` を定義、`export function` を使う
- `props: Props` で受け取る（destructuring しない）
- コンポーネントの説明コメントをつける

## Hooks

- useEffect 禁止
- useCallback 禁止
- useMemo は1000件以上の計算でのみ許可（理由コメント必須）

## TailwindCSS

- `pb-` でなく `space-` / `gap-` を使う

## ハイドレーション（SSR時）

- `new Date()` / `Math.random()` をレンダー中に使わない
- `window` / `document` を条件分岐で使わない
- `suppressHydrationWarning` 禁止

## エラー

- mutation は onError、関数は try-catch + instanceof Error
