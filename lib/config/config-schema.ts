import { z } from "zod"
import { PROMPT_PRESET_NAMES } from "@/engine/prompt-presets"

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/

const safeName = z.string().min(1).regex(NAME_PATTERN, "must match ^[a-z][a-z0-9_-]*$")

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
  /**
   * When true (default) leuco prepends a built-in dynamic preamble to the
   * agent's `developer_instructions` covering the bot's own Slack identity,
   * loop avoidance, sub-agent paths, and self-edit guidance. Set to false to
   * pass the per-agent TOML instructions through verbatim.
   */
  useCommonInstructions: z.boolean().default(true),
  /**
   * Named system-prompt presets to splice in between the dynamic preamble and
   * the per-agent TOML text. Names are validated against the registered set
   * in `lib/engine/prompt-presets.ts`. Defaults to `["friendly"]` so a fresh
   * agent has a usable Slack persona without extra configuration; pass an
   * empty array to opt out.
   */
  prompts: z.array(z.enum(PROMPT_PRESET_NAMES)).default(["friendly"]),
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
