// Resolved for non-Bun runtimes via `package.json` "exports". leuco ships its
// public API as TypeScript source and is only supported under Bun.
throw new Error(
  "leuco is Bun-only. Install Bun from https://bun.sh and import / run with Bun.",
)
