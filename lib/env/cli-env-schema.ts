import { z } from "zod"

export const cliEnvSchema = z.object({
  LEUCO_CWD: z.string().optional(),
  LEUCO_CODEX_BIN: z.string().optional(),
  LEUCO_PORT: z.coerce.number().int().positive().optional(),
})

export type CliEnv = z.infer<typeof cliEnvSchema>
