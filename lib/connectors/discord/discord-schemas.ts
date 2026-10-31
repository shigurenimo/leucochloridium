import { z } from "zod"

export const discordMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  content: z.string().default(""),
  author: z.object({ id: z.string(), bot: z.boolean().optional() }),
  mentions: z.array(z.object({ id: z.string() })).default([]),
  attachments: z
    .array(z.object({ id: z.string(), filename: z.string(), url: z.string() }))
    .default([]),
  webhook_id: z.string().optional(),
})
export const discordReactionSchema = z.object({
  user_id: z.string(),
  channel_id: z.string(),
  message_id: z.string(),
  guild_id: z.string().optional(),
  emoji: z.object({ id: z.string().nullable(), name: z.string().nullable() }),
  member: z.object({ user: z.object({ bot: z.boolean().optional() }).optional() }).optional(),
})
export const discordThreadSchema = z.object({
  id: z.string(),
  type: z.number(),
  parent_id: z.string().nullable().optional(),
  owner_id: z.string().optional(),
  member: z.object({ user_id: z.string().optional() }).optional(),
})
export const discordUserSchema = z.object({ id: z.string(), bot: z.boolean().optional() })
