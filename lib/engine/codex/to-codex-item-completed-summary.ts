import { z } from "zod"

const itemCompletedMetadataSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z
    .object({
      type: z.string(),
      id: z.string().optional(),
      status: z.string().optional(),
      phase: z.string().optional(),
      server: z.string().optional(),
      tool: z.string().optional(),
      durationMs: z.number().optional(),
      exitCode: z.number().optional(),
      text: z.string().optional(),
      arguments: z.unknown().optional(),
      result: z.unknown().optional(),
      error: z.unknown().optional(),
    })
    .passthrough(),
})

/**
 * `item/completed` can contain complete command or MCP results. Diagnostics
 * need correlation and status, not another copy of those potentially huge
 * payloads.
 */
export const toCodexItemCompletedSummary = (params: unknown): unknown | null => {
  const parsed = itemCompletedMetadataSchema.safeParse(params)
  if (!parsed.success) return null

  const item = parsed.data.item
  return {
    threadId: parsed.data.threadId.slice(0, 256),
    turnId: parsed.data.turnId.slice(0, 256),
    item: {
      type: item.type.slice(0, 256),
      id: item.id?.slice(0, 256) ?? null,
      status: item.status?.slice(0, 256) ?? null,
      phase: item.phase?.slice(0, 256) ?? null,
      server: item.server?.slice(0, 256) ?? null,
      tool: item.tool?.slice(0, 256) ?? null,
      durationMs: item.durationMs ?? null,
      exitCode: item.exitCode ?? null,
      textChars: item.text?.length ?? null,
      hasArguments: item.arguments !== undefined,
      hasResult: item.result !== undefined,
      hasError: item.error !== undefined && item.error !== null,
    },
  }
}
