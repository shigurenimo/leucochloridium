import { z } from "zod"

/**
 * Default gateway port. The daemon's streamable HTTP MCP route binds here so
 * tenants' codex children can reach `/mcp/<project>/<agent>` over loopback —
 * port stability matters because each tenant's CODEX_HOME config.toml records
 * the URL at write time. Override with `LEUCO_PORT` if it conflicts locally.
 */
export const DEFAULT_LEUCO_PORT = 7331

export const cliEnvSchema = z.object({
  LEUCO_CWD: z.string().optional(),
  LEUCO_CODEX_BIN: z.string().optional(),
  LEUCO_PORT: z.coerce.number().int().positive().default(DEFAULT_LEUCO_PORT),
})

export type CliEnv = z.infer<typeof cliEnvSchema>
