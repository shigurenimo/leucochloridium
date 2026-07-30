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
  id: z.union([z.string(), z.number()]),
  result: z.unknown(),
})

const errorResponseSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number()]),
  error: jsonRpcErrorSchema,
})

export const jsonRpcResponseSchema = z.union([successResponseSchema, errorResponseSchema])

export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  method: z.string(),
  params: z.unknown().optional(),
})

// Server→client request (`{id, method}` — e.g. codex approval prompts). Must
// sit before the notification schema in the union: the notification schema
// also matches these frames but strips `id`, and a dropped `id` means codex
// waits forever for a reply.
export const jsonRpcServerRequestSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
})

export const jsonRpcIncomingSchema = z.union([
  jsonRpcResponseSchema,
  jsonRpcServerRequestSchema,
  jsonRpcNotificationSchema,
])

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

/** `turn/start` response. */
export const turnStartResultSchema = z.object({
  turn: z
    .object({
      id: z.string(),
    })
    .passthrough(),
})

/** `item/agentMessage/delta` notification params. */
export const agentMessageDeltaSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
})

/** `item/commandExecution/outputDelta` notification params. */
export const commandExecutionOutputDeltaSchema = z.object({
  itemId: z.string().optional(),
  delta: z.string(),
})

/** `item/completed` — only the agentMessage variant carries the final text we care about. */
export const itemCompletedSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z
    .object({
      type: z.string(),
      id: z.string().optional(),
      text: z.string().optional(),
      phase: z.string().nullable().optional(),
    })
    .passthrough(),
})

export const turnCompletedSchema = z.object({
  threadId: z.string(),
  turn: z
    .object({
      id: z.string(),
      status: z.string(),
      error: z.unknown().nullable().optional(),
    })
    .passthrough(),
})

export const turnCompletedIdentitySchema = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string() }),
})

/** Common identities carried by notifications belonging to a running turn. */
export const turnNotificationIdentitySchema = z.union([
  z.object({
    threadId: z.string(),
    turnId: z.string(),
  }),
  turnCompletedIdentitySchema,
])

export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>
export type JsonRpcIncoming = z.infer<typeof jsonRpcIncomingSchema>
export type ThreadStartResult = z.infer<typeof threadStartResultSchema>
export type TurnStartResult = z.infer<typeof turnStartResultSchema>
