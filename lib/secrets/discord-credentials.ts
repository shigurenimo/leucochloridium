import { z } from "zod"

export const discordCredentialsSchema = z.strictObject({
  botToken: z
    .string()
    .min(20)
    .max(1024)
    .regex(/^[A-Za-z0-9._-]+$/),
})
export type DiscordCredentials = z.infer<typeof discordCredentialsSchema>
