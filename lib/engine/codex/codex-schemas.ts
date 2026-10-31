import { z } from "zod"
import { codexThreadIdSchema } from "@/codex-thread-id-schema"

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

const jsonRpcResponseSchema = z.union([successResponseSchema, errorResponseSchema])

const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  method: z.string(),
  params: z.unknown().optional(),
})

// Server→client request (`{id, method}` — e.g. codex approval prompts). Must
// sit before the notification schema in the union: the notification schema
// also matches these frames but strips `id`, and a dropped `id` means codex
// waits forever for a reply.
const jsonRpcServerRequestSchema = z.object({
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

const codexThreadSchema = z.object({
  id: codexThreadIdSchema,
})

export const threadStartResultSchema = z.object({
  thread: codexThreadSchema,
})

const codexTurnIdSchema = z.string().regex(/\S/, "Codex turn ID must not be blank")

/** `turn/start` response. */
export const turnStartResultSchema = z.object({
  turn: z.object({ id: codexTurnIdSchema }),
})

/** `item/agentMessage/delta` notification params. */
export const agentMessageDeltaSchema = z.object({
  threadId: z.string(),
  turnId: codexTurnIdSchema,
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
  turnId: codexTurnIdSchema,
  item: z.object({
    type: z.string(),
    text: z.string().optional(),
    phase: z.string().nullable().optional(),
  }),
})

export const turnCompletedSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    id: codexTurnIdSchema,
    status: z.string(),
    error: z.unknown().nullable().optional(),
  }),
})

export const turnCompletedIdentitySchema = z.object({
  threadId: z.string(),
  turn: z.object({ id: codexTurnIdSchema }),
})

/** Common identities carried by notifications belonging to a running turn. */
export const turnNotificationIdentitySchema = z
  .object({
    threadId: z.string(),
    turnId: codexTurnIdSchema.optional(),
    turn: z.object({ id: codexTurnIdSchema }).optional(),
  })
  .transform((identity, context) => {
    const turnId = identity.turnId ?? identity.turn?.id
    if (
      turnId === undefined ||
      (identity.turnId !== undefined &&
        identity.turn !== undefined &&
        identity.turnId !== identity.turn.id)
    ) {
      context.addIssue({
        code: "custom",
        message: "Codex notification must identify one unambiguous turn",
      })
      return z.NEVER
    }
    return { threadId: identity.threadId, turnId }
  })

export type ThreadStartResult = z.infer<typeof threadStartResultSchema>
export type TurnStartResult = z.infer<typeof turnStartResultSchema>
