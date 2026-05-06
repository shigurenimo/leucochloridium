---
name: software-stack-cli
description: TypeScript CLI/TUI/SDK library design on Bun + Hono + zod + vite-plus + vitest. One package hosts a daemon, a CLI, a TUI, and an importable library off the same composition root. Every IO boundary is a port type and every IO-heavy class extracts a pure inner class so the whole thing is mockable end to end.
user-invocable: false
disable-model-invocation: false
metadata:
  author: shigurenimo
  description: Bun + Hono + zod + vite-plus + vitest ベースの TypeScript CLI / TUI / SDK ライブラリ開発スキル。
  dev: true
  tags: [stack]
---

# CLI / TUI / SDK Library

A single package that ships as a CLI, a TUI, and an embeddable library, all driven by the same composition root. The design optimises for full mockability: each IO boundary is exposed as a port type and each IO-heavy class extracts a pure sibling.

Toolchain (vite-plus, vitest, `@/*` alias, fmt/lint config) lives in software-stack under vp.

## Layout

Everything lives under `lib/`. UI layers (`cli/`, `tui/`) depend on `runtime/`; only `runtime/` reaches into the core modules (`engine/`, `channels/`, `config/`, `gateway/`, `env/`, `daemon/`). Core never imports UI.

```
lib/
├── api.ts                  public exports (barrel)
├── index.ts                bin entry / argv dispatcher
├── error-message.ts        shared err.message helper
├── cli/                    argv → Hono router → handler
├── tui/                    @opentui/react components
├── runtime/                composition root
├── engine/                 core orchestrator
├── channels/               channel plugins (chat integrations)
├── config/                 .<app>/config.json read/write
├── daemon/                 PID / log / process supervision
├── env/                    env var loading + zod validation
└── gateway/                daemon ↔ UI/external HTTP IPC
```

Class names carry the project prefix (`<App>Engine`, `<App>Daemon`, `<App>ConfigStore`); filenames are kebab-case without the prefix because the directory provides the namespace. Type aliases stay unprefixed (`ChannelPlugin`, `ProcessResult`, `ThreadEntry`).

## Ports for IO boundaries

Every external SDK, child process, or HTTP boundary gets a `*Port` type that core code depends on; the real class structurally satisfies the port and tests pass in fakes. Concrete examples: `engine/codex/codex-client-port.ts` exports `CodexClientPort`, `channels/slack/web-client-port.ts` exports `WebClientPort`, `engine/channel-plugin.ts` exports the `ChannelPlugin` and `ChannelPluginContext` pair.

## Pure logic isolation

Inside any IO-heavy class — `<X>Listener`, `<X>Client`, `<X>Server` — pull the methods that don't touch fs, spawn, net, or third-party SDKs into a pure sibling. Use `<X>Processor` for event normalisation (dedup, filtering, mention strip), `<X>Protocol` for wire framing (JSON-RPC, NDJSON), and standalone helper files for one-off pure logic (`daemon/daemon-key.ts`, `gateway/build-gateway-app.ts`). Each pure class is unit-tested with synthetic input and a fake writer; no IO involved.

## Composition root

`runtime/runtime.ts` builds and owns every module. CLI and TUI call `<App>Runtime.build({ cwd, env, ... })` and never new core modules directly. Build returns `T | Error`, never throws.

```ts
export class <App>Runtime {
  private constructor(private readonly props: Built) {
    Object.freeze(this)
  }

  static build(props): <App>Runtime | Error {
    const configStore = new <App>ConfigStore({ cwd: props.cwd })
    const config = configStore.load()
    if (config instanceof Error) return config

    const channelHost = <App>ChannelHost.fromConfig({ config, env: props.env })
    if (channelHost instanceof Error) return channelHost

    const core = new <App>CoreClient(...)
    const engine = new <App>Engine({ core, plugins: channelHost.getPlugins(), ... })
    return new <App>Runtime({ configStore, channelHost, core, engine })
  }

  async start(): Promise<void | Error>
  async stop(): Promise<void>
}
```

## Stores

Wrap every file IO surface in a class. Constructor takes `cwd` (or scope), methods are `load() / save() / list() / add() / remove()`, no throws, returning `T | Error`. Pair each store with a sibling `<x>-schema.ts` that exports zod schemas plus `z.infer` types. Concrete files: `config/config-store.ts` plus `config/config-schema.ts` for app config, and per-domain stores like `engine/<x>/<x>-agent-store.ts`.

## Plugin abstraction

Replaceable behaviour goes through an interface plus a host. The host reads config and constructs plugin instances; the engine sees only the interface, never the concrete plugin types.

```ts
type ChannelPlugin = {
  readonly name: string
  start(ctx: ChannelPluginContext): Promise<void>
  stop(): Promise<void>
}

class <App>ChannelHost {
  static fromConfig(props): <App>ChannelHost | Error
  getPlugins(): readonly ChannelPlugin[]
}
```

## CLI router

`cli/utils/to-request.ts` converts argv into a `POST /<cmd>` request with a JSON body of `{ args, flags }`; Hono dispatches to handlers. Each handler reads the body via `cli/utils/read-cli-body.ts` (zod-parsed). Routes are flat, Remix-style: dots in the filename become path segments, and help text lives in a sibling file.

```
cli/
├── cli-factory.ts                Hono factory
├── routes/
│   ├── index.ts
│   ├── group.help.ts             root --help
│   ├── start.ts        + start.help.ts
│   ├── projects.add.ts + projects.add.help.ts   POST /projects/add
│   └── channels.list.ts          ...
└── utils/
    ├── to-request.ts             argv → POST
    ├── read-cli-body.ts
    ├── flag-bool.ts / flag-string.ts
    └── parse-<param>.ts          per-command flag parsers
```

## Daemon

A PID file gates double-start. State directory is `~/.<app>/daemons/<basename>-<sha1[:6]>/`. `stop` sends SIGTERM and leaves logs in place so `<app> logs -f` can `tail -F` against the same file. The pure `daemon-key.ts` (cwd → state-dir name) is a separate file so tests don't need fs.

```
daemon/
├── <app>-daemon.ts        start / stop / status / readPid / isRunning
└── daemon-key.ts          pure cwd → state-dir key
```

## Gateway (HTTP IPC)

`gateway/build-gateway-app.ts` is a pure factory that builds the Hono app from injected deps; `gateway/gateway-server.ts` is a thin Bun.serve wrapper around it. Tests run `app.request(...)` directly on the built app — no port binding, no sockets.

```
gateway/
├── build-gateway-app.ts          pure Hono factory
├── gateway-server.ts             Bun.serve wrapper
├── gateway-factory.ts            Hono factory + Env type
├── gateway-route-deps.ts
└── routes/
    ├── index.ts
    ├── health-route.ts
    ├── status-route.ts
    └── threads/
        ├── list-route.ts
        └── clear-route.ts
```

## Env

```
env/
├── cli-env-schema.ts             zod schema + type
└── <app>-env.ts                  class <App>Env (loadFile, parseCli)
```

`loadFile(path)` reads `.env`-style files without overwriting existing `process.env` keys. `parseCli()` runs the schema's `safeParse` and returns `T | Error`.

## Public API

Re-export every class, every port type, the major types, and the zod schemas from `lib/api.ts`. Point `package.json` `main`, `module`, `types`, and `exports.types` at `./lib/api.ts` so consumers can `import { LeucoRuntime, LeucoConfigStore, ... } from "<package>"`.

```json
{
  "main": "./lib/api.ts",
  "module": "./lib/api.ts",
  "types": "./lib/api.ts",
  "exports": {
    ".": {
      "types": "./lib/api.ts",
      "bun": "./lib/api.ts",
      "default": "./lib/api.ts"
    },
    "./package.json": "./package.json"
  }
}
```

## Tests

Run with `vp test run` and add `"test": "vp test run"` to `package.json` scripts. Test by layer: pure processor, protocol, and utility files take synthetic input/output unit tests; stores get a tmpdir and exercise real fs; the channel host runs against a fake config and fake env; the engine runs against a fake core (via the port) plus fake `ChannelPlugin`s; gateway routes are tested with `buildGatewayApp({ engine: fakeEngine })` followed by `app.request(...)`; adapters are tested with the relevant `*Port` faked, asserting the calls made.

## Project rules

No throws — return `T | Error`. No `as` (use never-narrowing for exhaustive discriminator unions). No destructuring; use explicit property access (`const x = obj.x`). One function or one class per file, with the filename matching the class or function name minus the project prefix in kebab-case. Absent values are `null`, never optional (`string | null`, never `string?`). Wire data is always parsed by zod schemas; types come from `z.infer`.

## Migration patterns

When pulling existing code into this layout:

```
loadEnvFile(path) function       ⇒ <App>Env class method
loadConfig / saveConfig fns      ⇒ <x>-store.ts class
nested routes <res>/<act>.ts     ⇒ flat <res>.<act>.ts
filename <dir>-<class>.ts        ⇒ filename <class>.ts (dir as namespace)
spawn + protocol same class      ⇒ <X>Client (IO) + <X>Protocol (pure)
new ExternalSdk(token) inline    ⇒ static fromXxx() factory + Port type
```
