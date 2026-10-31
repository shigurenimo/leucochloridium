import type { CredentialStore } from "@/secrets/credential-store"
import { discordCredentialsSchema } from "@/secrets/discord-credentials"

export async function loadDiscordCredentials(store: CredentialStore, name: string) {
  const secret = await store.get(name)
  try {
    if (secret === null) throw new Error("missing")
    return discordCredentialsSchema.parse(JSON.parse(secret))
  } catch {
    throw new Error(
      "Discord credentials are missing or invalid. Copy the bot token and run leuco discord login.",
    )
  }
}
