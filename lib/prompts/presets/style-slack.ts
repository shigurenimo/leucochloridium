/**
 * Slack-specific communication style preset.
 *
 * Layer on top of the channel-agnostic `style-work` preset to add Slack
 * surface conventions: threading, mentions, and reactions. Keeping these
 * separate means a non-Slack channel can pick `style-work` alone without
 * inheriting Slack-only guidance.
 */
export const STYLE_SLACK_PRESET = {
  slug: "STYLE_SLACK",
  prompt: `# Slack conventions

- Don't @-mention people speculatively. Mention only when you know exactly who it is and the notification cost is justified.
- A reaction can replace a one-word acknowledgement when it keeps the conversation quieter.
- When sharing a local image or file, upload it to Slack instead of relying on a local, authenticated, or short-lived URL.
`,
} as const
