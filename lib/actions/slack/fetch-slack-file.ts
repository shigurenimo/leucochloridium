import { assertSlackFileUrl } from "@/actions/slack/assert-slack-file-url"

const MAX_REDIRECT_HOPS = 3

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Fetch a Slack-hosted file with the bearer token, following redirects
 * manually. Automatic following would rely on the runtime to strip the
 * Authorization header cross-origin; instead every hop's Location is resolved
 * against the current URL and re-validated with `assertSlackFileUrl` before
 * the token is sent again.
 */
export const fetchSlackFile = async (url: string, botToken: string): Promise<Response> => {
  return await followSlackRedirects(url, botToken, MAX_REDIRECT_HOPS)
}

const followSlackRedirects = async (
  url: string,
  botToken: string,
  remainingHops: number,
): Promise<Response> => {
  const safeUrl = assertSlackFileUrl(url)

  const response = await fetch(safeUrl, {
    headers: {
      Authorization: `Bearer ${botToken}`,
    },
    redirect: "manual",
  })

  if (!REDIRECT_STATUSES.has(response.status)) return response

  if (remainingHops === 0) {
    throw new Error(`too many redirects downloading slack file: ${url}`)
  }

  const location = response.headers.get("location")
  if (location === null) {
    throw new Error(`redirect ${response.status} without location header: ${url}`)
  }

  const nextUrl = new URL(location, safeUrl).toString()
  return await followSlackRedirects(nextUrl, botToken, remainingHops - 1)
}
