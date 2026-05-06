import { z } from "zod"

/** JSON-RPC 2.0 envelopes (NDJSON over stdio). */

const jsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
})

// codex app-server sometimes omits the `jsonrpc: "2.0"` field on error responses,
// so the schemas treat it as optional rather than rejecting otherwise-valid frames.
const successResponseSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.number(),
  result: z.unknown(),
})

const errorResponseSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.number(),
  error: jsonRpcErrorSchema,
})

export const jsonRpcResponseSchema = z.union([successResponseSchema, errorResponseSchema])

export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  method: z.string(),
  params: z.unknown().optional(),
})

export const jsonRpcIncomingSchema = z.union([jsonRpcResponseSchema, jsonRpcNotificationSchema])

/** Codex domain shapes. */

export const codexThreadSchema = z.object({
  id: z.string(),
  preview: z.string().optional(),
  modelProvider: z.string().optional(),
  createdAt: z.number().optional(),
})

export const threadStartResultSchema = z.object({
  thread: codexThreadSchema,
})

/** `item/agentMessage/delta` notification params. */
export const agentMessageDeltaSchema = z.object({
  itemId: z.string().optional(),
  delta: z.string(),
})

/** `item/completed` — only the agentMessage variant carries the final text we care about. */
export const itemCompletedSchema = z.object({
  item: z
    .object({
      type: z.string(),
      id: z.string().optional(),
      text: z.string().optional(),
    })
    .passthrough(),
})

const codexTurnStatusSchema = z.enum(["inProgress", "completed", "interrupted", "failed"])

export const turnCompletedSchema = z.object({
  turn: z
    .object({
      id: z.string().optional(),
      status: codexTurnStatusSchema,
      error: z.object({ message: z.string() }).nullable().optional(),
    })
    .passthrough(),
})

export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>
export type JsonRpcIncoming = z.infer<typeof jsonRpcIncomingSchema>
export type ThreadStartResult = z.infer<typeof threadStartResultSchema>
