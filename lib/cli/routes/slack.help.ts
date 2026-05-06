export const help = `leuco slack — forward Slack Web API calls using a tenant's stored token

usage:
  leuco slack call <method> [--body '<json>'] --project <p> --agent <a> [--channel <c>]

  <method>            Slack Web API method (e.g. chat.postMessage)
  --body '<json>'     JSON body forwarded as the method arguments
  --project, --agent  tenant whose stored bot token is used
  --channel           pick a specific channel when the agent owns multiple

The same operation is exposed to codex as the MCP \`slack_call\` tool, so
agents can reach the full Slack surface without any extra plumbing.`
