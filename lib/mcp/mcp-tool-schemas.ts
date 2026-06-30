import { z } from "zod"

// Slack Web API method names are dotted identifiers like `chat.postMessage`,
// `files.info`, `admin.users.list`. Restricting to this shape blocks path
// traversal (`../admin.users.list`) and query injection (`files.info?token=…`)
// at the schema layer before the value ever reaches the fetch client.
const slackMethodPattern = /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/

export const slackCallArgsSchema = z.object({
  method: z
    .string()
    .min(1, "must be a non-empty string")
    .regex(slackMethodPattern, "must be a dotted Slack API method name"),
  body: z.record(z.string(), z.unknown()).optional(),
  channel_name: z.string().optional(),
})

export const slackDownloadFileArgsSchema = z
  .object({
    file_id: z.string().min(1, "must be a non-empty string").optional(),
    url: z.string().url().optional(),
    output_path: z.string().min(1, "must be a non-empty string").optional(),
    channel_name: z.string().optional(),
  })
  .refine((value) => value.file_id !== undefined || value.url !== undefined, {
    message: "one of `file_id` or `url` is required",
  })
  .refine((value) => !(value.file_id !== undefined && value.url !== undefined), {
    message: "use either `file_id` or `url`, not both",
  })

export const scheduleCreateArgsSchema = z.object({
  name: z.string().min(1).max(200),
  run_at: z.string().min(1).max(200),
  // Cap to keep `~/.leuco/settings.json` (where this prompt is persisted) at
  // a size the daemon can still read / atomic-write cheaply.
  prompt: z.string().min(1).max(10_000),
  channel_name: z.string().optional(),
})

export const scheduleListArgsSchema = z.object({
  channel_name: z.string().optional(),
})

export const scheduleDeleteArgsSchema = z.object({
  id_or_name: z.string(),
  channel_name: z.string().optional(),
})

export type SlackCallArgs = z.infer<typeof slackCallArgsSchema>
export type SlackDownloadFileArgs = z.infer<typeof slackDownloadFileArgsSchema>
export type ScheduleCreateArgs = z.infer<typeof scheduleCreateArgsSchema>
export type ScheduleListArgs = z.infer<typeof scheduleListArgsSchema>
export type ScheduleDeleteArgs = z.infer<typeof scheduleDeleteArgsSchema>

export const formatZodIssue = (error: z.ZodError): string => {
  const first = error.issues[0]
  if (!first) return "invalid arguments"
  const path = first.path.length > 0 ? `\`${first.path.join(".")}\`: ` : ""
  return `${path}${first.message}`
}
