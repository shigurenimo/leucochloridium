# CLAUDE.md

Notes for AI assistants working in this repo.

## What this is

`leuco` is a self-hosted, multi-tenant gateway that runs the Codex
`app-server` as a Slack bot (other channel types may follow). One daemon
per machine supervises every registered `(project, agent)` pair. The
daemon, the CLI, the live TUI, and the importable library all share a
single composition root in `lib/runtime/runtime.ts` (`LeucoRuntime`).

The user-facing flows are documented in README.md — keep this file focused
on conventions and codebase shape.

## Stack

- Runtime: Bun >= 1.3, TypeScript, ESM
- HTTP: Hono (also used internally to route the CLI: argv → POST request)
- Validation: Zod (every wire type is `z.infer<typeof schema>`)
- Slack: `@slack/bolt` Socket Mode listener + `@slack/web-api`
- TUI: `@opentui/core` + `@opentui/react`
- MCP: `@modelcontextprotocol/sdk` (stdio server spawned by codex)
- Tooling: vite-plus (`fmt` / `lint` / `check` / `test`), vitest

## Layout

```
lib/
├── index.ts              CLI entry (also handles `leuco mcp` and `--version`)
├── api.ts                public library surface
├── cli/                  hono app, route handlers (one file per route), argv parser
├── runtime/runtime.ts    composition root: scans projects → tenants → engine
├── engine/               LeucoEngine, LeucoTenant, ChannelPlugin port, codex/
├── channels/             channel-host + slack/ adapter / listener / processor
├── codex/ (under engine) codex client port, JSON-RPC protocol, agent TOML store
├── config/               zod schemas for projects/agents/channels
├── projects/             project registry + scaffolder
├── daemon/leuco-daemon.ts pid/log/spawn supervisor (one daemon per machine)
├── events/               typed event bus + events.jsonl writer
├── gateway/              optional HTTP gateway for IPC
├── mcp/start-mcp-server  stdio MCP server (spawned by codex per tenant)
├── paths/leuco-paths.ts  single source of truth for ~/.leuco/* paths
├── tui/                  opentui app, useEvents tail hook, launch-tui
├── env/                  zod-typed env loader
└── error-message.ts      narrow `unknown` to a string for logging
```

`~/.leuco` filesystem layout is documented in `lib/paths/leuco-paths.ts`
and the README. Every path goes through `LeucoPaths` — never compute it
inline.

## Conventions (must follow)

These are enforced project-wide. See `.claude/rules/*.md` for the source.

TypeScript:

- One function or class per file. `kebab-case.ts` filename matches the
  exported name (`startHandler` → `start.ts`).
- Imports use the `@/` absolute alias only — no relative paths.
- `type` only. No `interface`, no `enum`.
- `unknown` for unknowns. `any` and `as` are forbidden. `as unknown as T`
  is a last resort — if you reach for it, stop and find the root cause.
- Absence is `null`, not `undefined` or empty string. Optional fields use
  `T | null`.
- Wire types come from Zod schemas via `z.infer`. Never hand-roll a wire
  type next to a schema.
- Errors at the backend: do not `throw`. Return `T | Error` and discriminate
  with `instanceof Error`. The CLI / handler layer turns it into a 400/500.
- Functions: ≤ 3 args (use `props: Props` for 4+), ≤ 20 lines, prefer pure.
- Classes: `constructor(private readonly props: Props)` + `Object.freeze(this)`,
  immutable updates via `with*()`, `ReadonlyArray` over `T[]`.
- No destructuring. Use `props.foo`. `const` only.
- `for-of`, early return, `if`. No `switch` except in reducer-style
  exhaustive Action branches.
- Insert a blank line between statements at indent depth ≤ 2; tighten at
  deeper levels. See `.claude/rules/ts.md` for the canonical example.
- Comments are rare. Only when behaviour is non-obvious and the *why*
  isn't visible from the code. No `@param` / `@return`.

React (TUI only):

- Define `type Props`, `export function Foo(props: Props)`. Don't destructure.
- `useEffect` and `useCallback` are forbidden. `useMemo` only when computing
  over 1000+ items, with a comment explaining why.
- Use `gap-` / `space-` over `pb-` (n/a in opentui, kept here for symmetry
  with web).
- Mutations: `onError`. Plain async: `try/catch` + `instanceof Error`.

Git:

- English commit subjects, imperative, lower-case, no period.
- Prefix with `update:`, `fix:`, `feat:`, `refactor:`, `docs:`, `chore:`.

## Composition root

`LeucoRuntime.build({ env })` is the single wiring point. It:

1. Reads every project from `~/.leuco/projects/<p>/settings.json` via
   `LeucoProjectStore`.
2. Filters disabled agents/channels.
3. For each enabled `(project, agent)` builds a `LeucoTenant` with its own
   `LeucoCodexClient` (separate `CODEX_HOME`), channel plugins via
   `LeucoChannelHost`, and ack/onLog hooks bound to the shared
   `LeucoEventBus`.
4. Wraps everything in a `LeucoEngine` that owns reconcile / start / stop.

The daemon (`leuco run` or the spawned background child) just calls
`LeucoRuntime.build(...).start()`. The TUI tails the same event log.

## Ports and tests

Every IO boundary has a port type and the IO-heavy class extracts a pure
inner class so the whole thing is mockable. Examples:

- `CodexClientPort` ↔ `LeucoCodexClient` (real codex stdio process).
- `WebClientPort` ↔ Slack `WebClient`.
- `LeucoChannelHost` builds plugins from config; tests inject a fake host.

Tests live next to the source (`*.test.ts`). The repo uses `vite-plus`
directly (no wrapper scripts in `package.json` beyond `dev`):

```bash
vp test run          # one-shot test run
vp check             # fmt + lint + typecheck + test
tsc -b               # typecheck only
bun run dev          # run lib/index.ts in foreground
```

## CLI shape

Argv → URL/body conversion lives in `lib/cli/utils/to-request.ts`. Each
subcommand is a `POST /<segments>` route in `lib/cli/routes/`. Bare `leuco`
is `/`, which:

- launches the TUI when the daemon is running (`rootHandler`)
- otherwise starts the daemon (same code path as `leuco start`)

When you add a new route:

1. Add a `lib/cli/routes/<name>.ts` exporting `<name>Handler`.
2. Add a `lib/cli/routes/<name>.help.ts` with the help text and gate it via
   `if (flagBool(body.flags.help)) return c.text(help)`.
3. Register the route in `lib/cli/routes/index.ts`.
4. If it adds a new top-level verb, add it to `TOP_LEAFS` in `to-request.ts`
   and update `lib/cli/routes/group.help.ts`.

Help text is plain ASCII and uses two-space indentation; check sibling
files for tone.

## Common gotchas

- `process.exit(0)` after `await launchTui()` is required: the Hono
  handler's response would otherwise echo onto stdout while the renderer
  is still tearing down.
- Codex `app-server` requires the JSON-RPC `initialize` handshake before
  any request; error replies sometimes omit `jsonrpc`. See
  `lib/engine/codex/codex-protocol.ts`.
- `~/.leuco/projects/<p>/settings.json` is chmod 600 because it stores
  Slack tokens. `LeucoProjectStore.write` enforces the mode.
- Each tenant's `CODEX_HOME` symlinks `auth.json` from `~/.codex/auth.json`
  so all tenants share the user's codex login while keeping memories
  isolated.

## What not to do

- Don't introduce `interface`, `enum`, or `as` casts.
- Don't add `useEffect` / `useCallback` to TUI components.
- Don't add backwards-compatibility shims, dead `_unused` vars, or
  `// removed` comments. Delete unused code.
- Don't write feature flags or env-gated branches "just in case".
- Don't add summaries/explanations to commits or comments — the diff
  speaks for itself.
