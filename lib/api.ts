// Public API surface for Leuco.
//
// Consumers can either call `LeucoRuntime.build({ env })` for the
// fully-wired composition root, or assemble individual classes (LeucoEngine,
// LeucoCodexClient, LeucoSlackChannelPlugin, ...) directly for embedding.
// Every IO boundary exposes a port type so tests can substitute fakes.

// Channel plugin abstraction
export {
  LeucoChannelHost,
  type LeucoChannelHostBuildProps,
  type LeucoProjectRef,
} from "@/channels/channel-host"
export { LeucoSlackAdapter, type LeucoSlackAdapterProps } from "@/channels/slack/slack-adapter"
export {
  LeucoSlackChannelPlugin,
  type LeucoSlackChannelPluginProps,
  type SlackAckIcons,
  type SlackAckMode,
} from "@/channels/slack/slack-channel-plugin"
export type {
  ProcessEmit as SlackProcessEmit,
  ProcessResult as SlackProcessResult,
  ProcessSkip as SlackProcessSkip,
} from "@/channels/slack/slack-event-processor"
export {
  LeucoSlackEventProcessor,
  type LeucoSlackEventProcessorProps,
} from "@/channels/slack/slack-event-processor"
export {
  LeucoFetchSlackWebClient,
  type LeucoFetchSlackWebClientProps,
  type SlackFetchPort,
} from "@/channels/slack/leuco-fetch-slack-web-client"
export {
  diagnoseSlackDirectMessage,
  type SlackDirectMessageDiagnosis,
} from "@/actions/slack/diagnose-slack-direct-message"
export {
  LeucoFlumeSlackEventSource,
  type LeucoFlumeSlackEventSourceProps,
} from "@/channels/slack/leuco-flume-slack-event-source"
export { LeucoMemorySlackEventSource } from "@/channels/slack/leuco-memory-slack-event-source"
export {
  LeucoMemorySlackWebClient,
  type LeucoMemorySlackWebClientProps,
  type SlackMemoryResponder,
} from "@/channels/slack/leuco-memory-slack-web-client"
export {
  LeucoSlackEventSource,
  type LeucoSlackEnvelope,
  type LeucoSlackSourceLog,
  type LeucoSlackSourceStatus,
} from "@/channels/slack/leuco-slack-event-source"
export { LeucoSlackWebClient } from "@/channels/slack/leuco-slack-web-client"
export type {
  SlackEvent,
  SlackMessage,
  SlackMessageEvent,
  SlackReactionEvent,
  SlackReply,
} from "@/channels/slack/slack-types"

// Configuration (per-project JSON files)
export { CURRENT_SCHEMA_VERSION, EMPTY_PROJECT_STATE, projectSchema } from "@/config/config-schema"
export type {
  Channel,
  McpServer,
  Project,
  ProjectState,
  ScheduleChannel,
  ScheduleEntry,
  SlackChannel,
} from "@/config/config-schema"
export {
  GLOBAL_SETTINGS_KEYS,
  globalSettingsSchema,
  type GlobalSettings,
  type GlobalSettingsKey,
} from "@/global-settings/global-settings-schema"
export {
  LeucoGlobalSettingsStore,
  type LeucoGlobalSettingsStoreProps,
} from "@/global-settings/global-settings-store"
export { LeucoProjectStore, type LeucoProjectStoreProps } from "@/projects/project-store"

// Daemon (process supervision)
export {
  LeucoDaemon,
  type DaemonStartResult,
  type DaemonStatus,
  type DaemonStopResult,
  type LeucoDaemonProps,
  type LeucoDaemonStartProps,
} from "@/daemon/leuco-daemon"

// Structured event bus (SQLite + live subscribers)
export {
  DEFAULT_EVENT_LOG_MAX_AGE_MS,
  DEFAULT_EVENT_LOG_MAX_BYTES,
  DEFAULT_EVENT_LOG_MAX_ROWS,
  DEFAULT_EVENT_LOG_TARGET_BYTES,
  LeucoEventBus,
  type LeucoEventBusProps,
} from "@/events/leuco-event-bus"
export { leucoEventSchema } from "@/events/leuco-event-schema"
export type { LeucoEvent, LeucoEventListener } from "@/events/leuco-event-types"

// Filesystem layout
export { LeucoPaths, type LeucoPathsProps } from "@/paths/leuco-paths"

// Engine + Codex
export type {
  ChannelIdentity,
  ChannelPlugin,
  ChannelPluginContext,
} from "@/channels/channel-plugin"
export type { CodexClientPort } from "@/engine/codex/codex-client-port"
export { LeucoCodexClient, type LeucoCodexClientProps } from "@/engine/codex/codex-client"
export {
  LeucoCodexProtocol,
  type CodexLineWriter,
  type CodexNotificationHandler,
  type LeucoCodexProtocolProps,
} from "@/engine/codex/codex-protocol"
export type { ThreadStartResult } from "@/engine/codex/codex-schemas"
export type { ThreadStartParams, TurnInputItem, TurnStartParams } from "@/engine/codex/codex-types"
export {
  LeucoEngine,
  type EngineProjectSummary,
  type LeucoEngineProps,
  type ThreadEntry,
} from "@/engine/engine"
export {
  DEFAULT_TURN_IDLE_TIMEOUT_MS,
  DEFAULT_TURN_QUEUE_MAX_BYTES,
  DEFAULT_TURN_QUEUE_MAX_ITEMS,
  DEFAULT_TURN_TIMEOUT_MS,
  LeucoTenant,
  type LeucoTenantProps,
  type TenantAgentSpec,
  type TenantThreadEntry,
} from "@/engine/tenant"

// Environment
export { type CliEnv, cliEnvSchema } from "@/env/cli-env-schema"
export { LeucoEnv, type LoadEnvFileResult } from "@/env/leuco-env"

// Error helpers
export { errorMessage } from "@/error-message"

// Gateway (HTTP IPC)
export { buildGatewayApp } from "@/gateway/build-gateway-app"
export type { GatewayRouteDeps } from "@/gateway/gateway-route-deps"
export { LeucoGatewayServer, type LeucoGatewayServerProps } from "@/gateway/gateway-server"

// Project lifecycle
export {
  LeucoProjectScaffolder,
  type LeucoProjectCreateProps,
  type LeucoProjectScaffolderProps,
  type ProjectScaffoldResult,
} from "@/projects/project-scaffolder"

// Runtime (composition root)
export { LeucoRuntime, type LeucoRuntimeProps } from "@/runtime/runtime"
