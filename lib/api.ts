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

export { EventJournal } from "@/event-journal/event-journal"
export type { EventJournalProps, EventJournalValidator } from "@/event-journal/event-journal"
export type { EventJournalRecord } from "@/event-journal/event-journal-record"
export type { EventJournalRelay, EventJournalStore } from "@/event-journal/event-journal-store"
export { MemoryEventJournal } from "@/event-journal/memory-event-journal"
export type { MemoryEventJournalProps } from "@/event-journal/memory-event-journal"
export { SqliteEventJournal } from "@/event-journal/sqlite-event-journal"
export type {
  SqliteEventJournalProps,
  SqliteEventJournalQuery,
} from "@/event-journal/sqlite-event-journal"

export {
  DEFAULT_EVENT_LOG_MAX_AGE_MS,
  DEFAULT_EVENT_LOG_MAX_BYTES,
  DEFAULT_EVENT_LOG_MAX_ROWS,
  DEFAULT_EVENT_LOG_TARGET_BYTES,
  LeucoEventJournal,
} from "@/events/leuco-event-journal"
export type { LeucoEventJournalProps } from "@/events/leuco-event-journal"
export { leucoEventSchema } from "@/events/leuco-event-schema"
export type { LeucoEvent } from "@/events/leuco-event-types"

export { LeucoRuntime } from "@/runtime/runtime"
export type { LeucoRuntimeProps } from "@/runtime/runtime"
