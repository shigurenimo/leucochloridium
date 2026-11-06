import type { z } from "zod"
import { DEFAULT_SLACK_ACK_MODE, type LeucoSettings } from "@/config/config-schema"
import type { CredentialStore } from "@/secrets/credential-store"
import { discordCredentialsSchema } from "@/secrets/discord-credentials"
import { readSlackCredentialDraft } from "@/secrets/read-slack-credential-draft"
import { slackCredentialsSchema } from "@/secrets/slack-credentials"

export type ChatProvider = "slack" | "discord"

export type ChatToken = {
  kind: string
  field: "botToken" | "appToken"
  schema: z.ZodString
  format: string | null
  login: string
}

type ChatCredentialDraft = Partial<Record<ChatToken["field"], string>>

type ChatProviderDefinition = {
  name: string
  tokens: ChatToken[]
  actions: string[]
  readDraft(credentials: CredentialStore, reference: string | null): Promise<ChatCredentialDraft>
  withCredential(settings: LeucoSettings, credential: string | null): LeucoSettings
  toLoginResult(kind: string, missing: string[]): Record<string, unknown>
}

export const CHAT_PROVIDERS: Record<ChatProvider, ChatProviderDefinition> = {
  slack: {
    name: "Slack",
    tokens: [
      {
        kind: "bot",
        field: "botToken",
        schema: slackCredentialsSchema.shape.botToken,
        format: "xox...",
        login: "leuco slack login bot",
      },
      {
        kind: "app",
        field: "appToken",
        schema: slackCredentialsSchema.shape.appToken,
        format: "xapp-...",
        login: "leuco slack login app",
      },
    ],
    actions: ["call", "upload-file", "download-file"],
    readDraft: readSlackCredentialDraft,
    withCredential: (settings, credential) => ({
      ...settings,
      slack:
        credential === null
          ? null
          : { credential, ackMode: settings.slack?.ackMode ?? DEFAULT_SLACK_ACK_MODE },
    }),
    toLoginResult: (kind, missing) => ({
      slack: "saved in OS credential store",
      saved: kind,
      complete: missing.length === 0,
      missing,
      restartRequired: true,
    }),
  },
  discord: {
    name: "Discord",
    tokens: [
      {
        kind: "bot",
        field: "botToken",
        schema: discordCredentialsSchema.shape.botToken,
        format: null,
        login: "leuco discord login",
      },
    ],
    actions: ["call"],
    // The only Discord token replaces the whole credential, so the previous one is never read.
    readDraft: async () => ({}),
    withCredential: (settings, credential) => ({
      ...settings,
      discord:
        credential === null
          ? null
          : { credential, messageContent: settings.discord?.messageContent ?? true },
    }),
    toLoginResult: () => ({
      discord: "saved in OS credential store",
      complete: true,
      restartRequired: true,
    }),
  },
}
