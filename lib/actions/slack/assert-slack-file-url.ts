const SLACK_HOST = "slack.com"
const SLACK_HOST_SUFFIX = ".slack.com"

/**
 * Guard the download URL before a Slack bot token is attached as a Bearer
 * header. Slack `url_private` / `url_private_download` always live on
 * `files.slack.com`; an attacker who can reach the agent could otherwise
 * coax it into downloading an arbitrary URL and exfiltrate the token via the
 * `Authorization` header. Only `https://*.slack.com` hosts are allowed.
 */
export const assertSlackFileUrl = (url: string): URL => {
  const parsed = parseUrl(url)

  if (parsed.protocol !== "https:") {
    throw new Error(`download url must be https, got ${parsed.protocol}`)
  }

  const host = parsed.hostname.toLowerCase()
  const isSlackHost = host === SLACK_HOST || host.endsWith(SLACK_HOST_SUFFIX)
  if (!isSlackHost) {
    throw new Error(`refusing to send slack token to non-slack host: ${host}`)
  }

  return parsed
}

const parseUrl = (url: string): URL => {
  try {
    return new URL(url)
  } catch {
    throw new Error(`invalid download url: ${url}`)
  }
}
