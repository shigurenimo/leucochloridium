/** Stable package surface. CLI, daemon, gateway, and concrete connectors are internal. */

export type {
  Connector,
  ConnectorContext,
  ConnectorIdentity,
  RunTextTurnOptions,
  TurnPriority,
} from "@/connectors/connector"

export { CURRENT_SCHEMA_VERSION, projectSchema } from "@/config/config-schema"
export type {
  ConnectorConfig,
  ConversationScope,
  McpServer,
  Project,
  ScheduleConnectorConfig,
  ScheduleEntry,
  SlackConnectorConfig,
} from "@/config/config-schema"

export { EventLog } from "@/event-log/event-log"
export type { EventLogProps, EventLogValidator } from "@/event-log/event-log"
export type { EventLogEntry } from "@/event-log/event-log-entry"
export type { EventLogRelay, EventLogStore } from "@/event-log/event-log-store"
export { MemoryEventLog } from "@/event-log/memory-event-log"
export type { MemoryEventLogProps } from "@/event-log/memory-event-log"
export { SqliteEventLog } from "@/event-log/sqlite-event-log"
export type { SqliteEventLogProps, SqliteEventLogQuery } from "@/event-log/sqlite-event-log"

export {
  DEFAULT_EVENT_LOG_MAX_AGE_MS,
  DEFAULT_EVENT_LOG_MAX_BYTES,
  DEFAULT_EVENT_LOG_MAX_ROWS,
  DEFAULT_EVENT_LOG_TARGET_BYTES,
  LeucoEventLog,
} from "@/events/leuco-event-log"
export type { LeucoEventLogProps } from "@/events/leuco-event-log"
export { leucoEventSchema } from "@/events/leuco-event-schema"
export type { LeucoEvent } from "@/events/leuco-event-types"

export { LeucoRuntime } from "@/runtime/runtime"
export type { LeucoProjectTurnProps, LeucoRuntimeProps } from "@/runtime/runtime"
export type { LeucoHostInstructions } from "@/prompts/host-instructions"
