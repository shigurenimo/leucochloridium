import { assertSlackFileUrl } from "@/actions/slack/assert-slack-file-url"

const MAX_REDIRECT_HOPS = 3
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Fetch a Slack-hosted file with the bearer token, following redirects
 * manually. Automatic following would rely on the runtime to strip the
 * Authorization header cross-origin; instead every hop's Location is resolved
 * against the current URL and re-validated with `assertSlackFileUrl` before
 * the token is sent again.
 */
export const fetchSlackFile = async (
  url: string,
  botToken: string,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Response> => {
  return await followSlackRedirects(url, botToken, MAX_REDIRECT_HOPS, timeoutMs, signal)
}

const followSlackRedirects = async (
  url: string,
  botToken: string,
  remainingHops: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> => {
  const safeUrl = assertSlackFileUrl(url)

  const controller = signal === undefined ? new AbortController() : null
  const requestSignal = signal ?? controller?.signal
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(safeUrl, {
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
      redirect: "manual",
      signal: requestSignal,
    })
  } catch (err) {
    if (controller?.signal.aborted === true) {
      throw new Error(`slack file download timed out after ${timeoutMs}ms: ${safeUrl.hostname}`)
    }
    throw err
  } finally {
    if (timer !== null) clearTimeout(timer)
  }

  if (!REDIRECT_STATUSES.has(response.status)) return response

  if (remainingHops === 0) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`too many redirects downloading slack file: ${url}`)
  }

  const location = response.headers.get("location")
  if (location === null) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`redirect ${response.status} without location header: ${url}`)
  }

  const nextUrl = new URL(location, safeUrl).toString()
  await response.body?.cancel().catch(() => undefined)
  return await followSlackRedirects(nextUrl, botToken, remainingHops - 1, timeoutMs, signal)
}
