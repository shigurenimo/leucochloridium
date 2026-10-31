export type DiscordApi = (
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
) => Promise<unknown>
