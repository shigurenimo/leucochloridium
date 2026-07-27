/** Default hard limit for a single Codex turn. */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000

/** Default period without Codex notifications before a turn is considered stalled. */
export const DEFAULT_TURN_IDLE_TIMEOUT_MS = 2 * 60 * 1000

/** Maximum number of different conversation threads that may run at once per project. */
export const DEFAULT_TURN_CONCURRENCY = 4

/** Maximum number of turns retained while one project turn is already running. */
export const DEFAULT_TURN_QUEUE_MAX_ITEMS = 64

/** Maximum UTF-8 bytes retained across one project's pending turn queue. */
export const DEFAULT_TURN_QUEUE_MAX_BYTES = 256 * 1024
