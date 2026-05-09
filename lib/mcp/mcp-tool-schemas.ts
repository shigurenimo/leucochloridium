import { z } from "zod"

export const slackCallArgsSchema = z.object({
  method: z.string().min(1, "must be a non-empty string"),
  body: z.record(z.string(), z.unknown()).optional(),
  channel_name: z.string().optional(),
})

export const scheduleCreateArgsSchema = z.object({
  name: z.string(),
  run_at: z.string(),
  prompt: z.string(),
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
export type ScheduleCreateArgs = z.infer<typeof scheduleCreateArgsSchema>
export type ScheduleListArgs = z.infer<typeof scheduleListArgsSchema>
export type ScheduleDeleteArgs = z.infer<typeof scheduleDeleteArgsSchema>

export const formatZodIssue = (error: z.ZodError): string => {
  const first = error.issues[0]
  if (!first) return "invalid arguments"
  const path = first.path.length > 0 ? `\`${first.path.join(".")}\`: ` : ""
  return `${path}${first.message}`
}
