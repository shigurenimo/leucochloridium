import { z } from "zod"

/**
 * Default loopback gateway port for daemon health, status, and thread control.
 * Override with `LEUCO_PORT` if it conflicts locally.
 */
export const DEFAULT_LEUCO_PORT = 7331

export const cliEnvSchema = z.object({
  LEUCO_CWD: z.string().optional(),
  LEUCO_CODEX_BIN: z.string().optional(),
  LEUCO_PROJECT_ID: z.string().uuid().optional(),
  LEUCO_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_LEUCO_PORT),
})

export type CliEnv = z.infer<typeof cliEnvSchema>
