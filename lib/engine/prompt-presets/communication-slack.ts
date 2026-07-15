/**
 * Slack-specific communication rules.
 *
 * Layer on top of the channel-agnostic `work-communication` preset to add
 * Slack surface conventions: threading, mentions, and reactions. Keeping
 * these separate means a non-Slack channel can pick `work-communication`
 * alone without inheriting Slack-only guidance.
 */
export const COMMUNICATION_SLACK_PROMPT = `# Slack conventions

- Don't @-mention people speculatively. Mention only when you know exactly who it is and the notification cost is justified.
- A reaction can replace a one-word acknowledgement when it keeps the conversation quieter.
- When sharing a local image or file, upload it to Slack instead of relying on a local, authenticated, or short-lived URL.
`
