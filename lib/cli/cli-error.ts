export type CliErrorCode =
  | "USAGE"
  | "NOT_RUNNING"
  | "STATE_CONFLICT"
  | "NEEDS_HUMAN"
  | "STATE_UNCERTAIN"
  | "CHECK_FAILED"
  | "OPERATION_FAILED"
export const ERROR_CODES = {
  USAGE: { exitCode: 2, recovery: "Read --help and fix the input before calling again." },
  NOT_RUNNING: {
    exitCode: 3,
    recovery: "Observe status. Start the daemon only when needed and authorized.",
  },
  STATE_CONFLICT: {
    exitCode: 3,
    recovery:
      "Inspect status; stop before changing credentials or mappings. Do not start a duplicate daemon.",
  },
  NEEDS_HUMAN: {
    exitCode: 4,
    recovery:
      "Ask the human to copy the required token into the desktop clipboard, then run slack login bot or slack login app. Never request token values in chat.",
  },
  STATE_UNCERTAIN: {
    exitCode: 5,
    recovery:
      "Inspect status, logs, events or the external destination. Do not blindly repeat a potentially accepted operation.",
  },
  CHECK_FAILED: {
    exitCode: 1,
    recovery: "Inspect error.details and repair the reported environment checks.",
  },
  OPERATION_FAILED: {
    exitCode: 1,
    recovery:
      "Inspect the failure and current state. Mutating operations may have partially completed; do not automatically replay them.",
  },
}
export class CliError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message)
    this.name = "CliError"
  }
}
