export const help = `leuco slack / forward Slack Web API calls using a project's stored token

usage / leuco slack call <method> --project <p> [--body '<json>'] [--channel <c>]

options:
  <method> / Slack Web API method (e.g. chat.postMessage)
  --body '<json>' / JSON body forwarded as the method arguments
  --project / project whose stored bot token is used
  --channel / pick a specific channel when the project has multiple

The same operation is exposed to codex as the MCP \`slack_call\` tool.`
