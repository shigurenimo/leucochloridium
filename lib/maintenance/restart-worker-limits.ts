export const RESTART_WORKER_PUBLICATION_TIMEOUT_MS = 5000
export const RESTART_WORKER_START_DELAY_MS = 500
/** The daemon answers /stop only after its runtime stopped, so this timeout alone does not end the restart. */
export const RESTART_STOP_REQUEST_TIMEOUT_MS = 5000
/** Covers the daemon stop path: Codex SIGTERM 5 s + SIGKILL 5 s, control drain 1 s + forced close 1 s, history close. */
export const RESTART_OLD_DAEMON_EXIT_TIMEOUT_MS = 20_000
export const RESTART_REPLACEMENT_READY_TIMEOUT_MS = 30_000
