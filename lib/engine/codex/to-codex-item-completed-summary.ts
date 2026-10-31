import { z } from "zod"
import { sliceTextPrefix } from "@/slice-text-prefix"

const itemCompletedMetadataSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({
    type: z.string(),
    id: z.string().optional(),
    status: z.string().optional(),
    phase: z.string().nullable().optional(),
    server: z.string().optional(),
    tool: z.string().optional(),
    durationMs: z.number().nullable().optional(),
    exitCode: z.number().nullable().optional(),
    text: z.string().optional(),
    arguments: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
})

/**
 * `item/completed` can contain complete command or MCP results. Diagnostics
 * need correlation and status, not another copy of those potentially huge
 * payloads.
 */
export const toCodexItemCompletedSummary = (
  params: unknown,
  redactText: (text: string) => string = (text) => text,
): unknown | null => {
  const parsed = itemCompletedMetadataSchema.safeParse(params)
  if (!parsed.success) return null

  const item = parsed.data.item
  const bounded = (text: string): string => sliceTextPrefix(redactText(text), 256)
  return {
    threadId: bounded(parsed.data.threadId),
    turnId: bounded(parsed.data.turnId),
    item: {
      type: bounded(item.type),
      id: item.id === undefined ? null : bounded(item.id),
      status: item.status === undefined ? null : bounded(item.status),
      phase: typeof item.phase === "string" ? bounded(item.phase) : null,
      server: item.server === undefined ? null : bounded(item.server),
      tool: item.tool === undefined ? null : bounded(item.tool),
      durationMs: item.durationMs ?? null,
      exitCode: item.exitCode ?? null,
      textChars: item.text?.length ?? null,
      hasArguments: item.arguments !== undefined,
      hasResult: item.result !== undefined,
      hasError: item.error !== undefined && item.error !== null,
    },
  }
}
