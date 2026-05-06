---
name: software-stack
description: Pick a stack skill for the project shape and decide which cross-cutting tools to install. Routes CLI/TUI/SDK to software-stack-cli, Hono backend to software-stack-hono, React SPA to software-stack-tanstack, React SSR/RSC to Next.js. Each tool entry tells you when to install, why, and how.
user-invocable: false
disable-model-invocation: false
metadata:
  author: shigurenimo
  description: 技術選定と共有ツール選定をカバーするメタスキル。
  dev: true
  tags: [stack]
---

# software-stack

Route by project shape. CLI, TUI, or SDK library go to software-stack-cli. Hono backend goes to software-stack-hono. React SPA with typed routing goes to software-stack-tanstack. React SSR or RSC on Vercel uses Next.js directly.

Prefer CLI over plugin over skill over MCP. MCP is the last resort. If a CLI replaces an MCP, remove the MCP. Strip duplicates aggressively.

## Migrations

Detect and propose: GitHub MCP becomes `gh`. Chrome DevTools MCP becomes agent-browser. context7 MCP becomes the `context7@claude-plugins-official` plugin. shadcn MCP becomes `npx skills add shadcn/ui`. Sentry MCP becomes `npx skills add getsentry/sentry-for-ai`. Biome, Prettier, ESLint, and the Vitest CLI all collapse into vp. Run `claude mcp remove <name>` only after the replacement is in place.

## Cross-cutting tools

Each tool is install-on-demand. Decide per project before installing.

### gh

Install (`brew install gh` if missing) whenever a GitHub URL, PR number, issue, or release task appears. This is the primary GitHub surface and replaces the GitHub MCP.

### vp (vite-plus)

Use vp whenever `package.json` lists `vite-plus`, `vite.config.ts` imports from it, or you are introducing a fmt/lint/test toolchain from scratch. The single binary bundles Vite, Vitest, Oxlint, Oxfmt, Rolldown, and tsdown, exposing `vp fmt`, `vp lint`, `vp test`, `vp dev`, `vp build`. Install globally with `bun add -g vite-plus`; per project add `bun add -d vite-plus` plus `bun add -d vitest` (vitest is only there so TypeScript can resolve test types — the runtime ships inside vite-plus). CI gets `voidzero-dev/setup-vp@v1`.

For projects that use a path alias, the canonical `vite.config.ts`:

```ts
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite-plus"

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./lib", import.meta.url)) } },
  fmt: { semi: false },
  lint: { ignorePatterns: ["node_modules/**", "lib/**/*.test.ts"] },
})
```

### sentry-cli

Install with `npm install -g @sentry/cli` when `@sentry/*` packages or `sentry.client.config.*` / `sentry.server.config.*` files exist and the user needs to query issues, upload source maps, or wire releases. Replaces the Sentry MCP.

### portless

Install when the project plans to run two or more local dev servers (Vite, Next, Bun, Hono) at once. It hands out stable `https://<name>.localhost` URLs to dodge port collisions. On macOS: `portless trust` then `inta config portless`. Operational rules live at `.claude/rules/portless.md`.

### agent-browser

Install with `npm install -g agent-browser` followed by `agent-browser install` when the agent needs to drive a browser (form fill, screenshot, UI verification). Replaces the Chrome DevTools MCP.

### playwright test-agents

Run `npx playwright init-agents --loop=claude` per project when a web product needs agent-friendly E2E authoring and execution. Assumes Playwright is already chosen.

### @google/design.md

Install when the project maintains a `DESIGN.md`. Provides lint, diff, and export so the design doc stays internally consistent.

## Baseline plugins

Always-on plugin list:

```json
"enabledPlugins": {
  "claude-md-management@claude-plugins-official": true,
  "commit-commands@claude-plugins-official": true,
  "context7@claude-plugins-official": true,
  "document-skills@anthropic-agent-skills": true,
  "feature-dev@claude-plugins-official": true,
  "frontend-design@claude-plugins-official": true,
  "pr-review-toolkit@claude-plugins-official": true,
  "security-guidance@claude-plugins-official": true,
  "typescript-lsp@claude-plugins-official": true
}
```

Avoid workflow-coercive plugins (superpowers-style); leave judgment to the model.

## Inspection

Inspect `package.json`, `.mcp.json`, `enabledPlugins`, `components.json`, `playwright.config.*`, `next.config.*`, Hono imports, Sentry packages, and lint config. Surface what is missing and what should be migrated. Run installs only after explicit approval.
