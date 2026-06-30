// Public API surface for leucochloridium.
//
// Consumers can either call `LeucoRuntime.build({ cwd, env })` for the
// fully-wired composition root, or assemble individual classes (LeucoEngine,
// LeucoCodexClient, LeucoSlackChannelPlugin, ...) directly for embedding.
// Every IO boundary exposes a port type so tests can substitute fakes.

// Channel plugin abstraction
export { LeucoChannelHost } from "@/channels/channel-host"
export { LeucoSlackAdapter } from "@/channels/slack/slack-adapter"
export { LeucoSlackChannelPlugin } from "@/channels/slack/slack-channel-plugin"
export type {
  ProcessEmit as SlackProcessEmit,
  ProcessResult as SlackProcessResult,
  ProcessSkip as SlackProcessSkip,
} from "@/channels/slack/slack-event-processor"
export { LeucoSlackEventProcessor } from "@/channels/slack/slack-event-processor"
export { LeucoFetchSlackWebClient } from "@/channels/slack/leuco-fetch-slack-web-client"
export { LeucoFlumeSlackEventSource } from "@/channels/slack/leuco-flume-slack-event-source"
export { LeucoMemorySlackEventSource } from "@/channels/slack/leuco-memory-slack-event-source"
export { LeucoMemorySlackWebClient } from "@/channels/slack/leuco-memory-slack-web-client"
export {
  LeucoSlackEventSource,
  type LeucoSlackEnvelope,
  type LeucoSlackSourceLog,
  type LeucoSlackSourceStatus,
} from "@/channels/slack/leuco-slack-event-source"
export { LeucoSlackWebClient } from "@/channels/slack/leuco-slack-web-client"
export type { SlackMessage, SlackReply } from "@/channels/slack/slack-types"

// Configuration (per-project JSON files)
export { projectSchema } from "@/config/config-schema"
export type { Channel, Project } from "@/config/config-schema"
export { LeucoProjectStore } from "@/projects/project-store"

// Daemon (process supervision)
export { LeucoDaemon } from "@/daemon/leuco-daemon"

// Structured event bus (events.jsonl + live subscribers)
export { LeucoEventBus } from "@/events/leuco-event-bus"
export type { LeucoEvent, LeucoEventListener } from "@/events/leuco-event-types"

// Filesystem layout
export { LeucoPaths } from "@/paths/leuco-paths"

// Engine + Codex
export type { ChannelPlugin, ChannelPluginContext } from "@/engine/channel-plugin"
export type { CodexClientPort } from "@/engine/codex/codex-client-port"
export { LeucoCodexClient } from "@/engine/codex/codex-client"
export { LeucoCodexProtocol } from "@/engine/codex/codex-protocol"
export type { ThreadStartResult } from "@/engine/codex/codex-schemas"
export type { ThreadStartParams, TurnInputItem, TurnStartParams } from "@/engine/codex/codex-types"
export { LeucoEngine, type ThreadEntry } from "@/engine/engine"
export { LeucoTenant } from "@/engine/tenant"

// Environment
export { type CliEnv, cliEnvSchema } from "@/env/cli-env-schema"
export { LeucoEnv, type LoadEnvFileResult } from "@/env/leuco-env"

// Error helpers
export { errorMessage } from "@/error-message"

// Gateway (HTTP IPC)
export { buildGatewayApp } from "@/gateway/build-gateway-app"
export type { GatewayRouteDeps } from "@/gateway/gateway-route-deps"
export { LeucoGatewayServer } from "@/gateway/gateway-server"

// Project lifecycle
export { LeucoProjectScaffolder } from "@/projects/project-scaffolder"

// Runtime (composition root)
export { LeucoRuntime } from "@/runtime/runtime"
