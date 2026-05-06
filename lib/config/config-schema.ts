import { z } from "zod"

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/

const safeName = z
  .string()
  .min(1)
  .regex(NAME_PATTERN, "must match ^[a-z][a-z0-9_-]*$")

const ackIconsSchema = z
  .object({
    progress: z.string().default("hourglass_flowing_sand"),
    success: z.string().default("white_check_mark"),
    error: z.string().default("x"),
  })
  .default({
    progress: "hourglass_flowing_sand",
    success: "white_check_mark",
    error: "x",
  })

const slackChannelSchema = z.object({
  id: z.uuid(),
  name: safeName,
  type: z.literal("slack"),
  enabled: z.boolean().default(true),
  botToken: z.string().default(""),
  appToken: z.string().default(""),
  /**
   * When the bot adds the in-progress / done / error reactions to the
   * incoming message:
   *   - "off": never (codex is fully responsible for any visible feedback)
   *   - "mention": only when the bot is @-mentioned (default)
   *   - "always": every accepted message event
   * Reaction events themselves never trigger ack — they are silent regardless.
   */
  ackMode: z.enum(["off", "mention", "always"]).default("mention"),
  /** Override the emoji names used by the ack reactions. Slack reaction names without `:`. */
  ackIcons: ackIconsSchema,
})

const channelSchema = z.discriminatedUnion("type", [slackChannelSchema])

const agentSchema = z.object({
  name: safeName,
  enabled: z.boolean().default(true),
  /**
   * Codex `thread/start` id this agent uses across every channel and turn.
   * Set the first time the agent runs; reused via `thread/resume` afterward.
   * Absent until the first turn fires.
   */
  codexThreadId: z.string().min(1).optional(),
  channels: z.array(channelSchema).default([]),
})

export const projectSchema = z.object({
  name: safeName,
  path: z.string().min(1),
  agents: z.array(agentSchema).default([]),
})

export type Channel = z.infer<typeof channelSchema>
export type Agent = z.infer<typeof agentSchema>
export type Project = z.infer<typeof projectSchema>
