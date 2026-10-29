import { z } from "zod"

export const slackCredentialsSchema = z.strictObject({
  botToken: z
    .string()
    .min(8)
    .max(1024)
    .regex(/^xox[A-Za-z0-9._-]+$/),
  appToken: z
    .string()
    .min(8)
    .max(1024)
    .regex(/^xapp-[A-Za-z0-9._-]+$/),
})
export type SlackCredentials = z.infer<typeof slackCredentialsSchema>

export const slackCredentialDraftSchema = slackCredentialsSchema.partial()
export type SlackCredentialDraft = z.infer<typeof slackCredentialDraftSchema>
