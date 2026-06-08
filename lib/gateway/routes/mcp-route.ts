import { timingSafeEqual } from "node:crypto"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { HTTPException } from "hono/http-exception"
import { factory } from "@/gateway/gateway-factory"
import { buildMcpServer } from "@/mcp/build-mcp-server"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/

/**
 * Streamable HTTP MCP endpoint at `/mcp/:projectId/:agent`. The path is keyed
 * by the project's UUID (not its display name) so renames never invalidate the
 * URL a running codex child holds. Codex tenants point their
 * `[mcp_servers.leuco]` here via the daemon-wide bearer token (written into
 * each tenant's CODEX_HOME config.toml as `bearer_token_env_var`); this
 * replaces the per-tenant `leuco mcp` stdio child and removes the orphan-MCP
 * failure mode entirely.
 *
 * Stateless mode (`sessionIdGenerator: undefined`) + a freshly built `Server`
 * per request: tools are stateless and the per-request cost is trivial, so we
 * skip session bookkeeping rather than tracking transport instances per
 * (project, agent) pair across restarts. The transport and server are closed
 * in a `finally` so the per-request objects (event listeners, schemas) do not
 * accumulate across calls.
 */
export const mcpHandler = factory.createHandlers(async (c) => {
  const deps = c.var.deps
  if (deps.mcpToken === null) {
    throw new HTTPException(503, { message: "mcp endpoint disabled" })
  }

  const header = c.req.header("authorization") ?? ""
  const presented = header.startsWith("Bearer ") ? header.slice(7) : ""
  if (!bearerMatches(presented, deps.mcpToken)) {
    throw new HTTPException(401, { message: "unauthorized" })
  }

  const projectId = c.req.param("project")
  const agentName = c.req.param("agent")
  if (!projectId || !agentName) {
    throw new HTTPException(400, { message: "project and agent required" })
  }
  if (!UUID_PATTERN.test(projectId)) {
    throw new HTTPException(400, { message: "project must be a uuid" })
  }
  if (!SAFE_NAME_PATTERN.test(agentName)) {
    throw new HTTPException(400, { message: "agent name must match ^[a-z][a-z0-9_-]*$" })
  }

  const server = buildMcpServer({ projectId, agentName })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    await transport.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }

  // Register the abort listener BEFORE handleRequest so an early client
  // disconnect during the streaming body still tears down the transport.
  c.req.raw.signal.addEventListener("abort", () => {
    void cleanup()
  })

  try {
    await server.connect(transport)
    return await transport.handleRequest(c.req.raw)
  } catch (error) {
    await cleanup()
    throw error
  } finally {
    // For the non-streaming JSON response path (`enableJsonResponse: true`),
    // handleRequest resolves once the body is fully written, so closing here
    // is safe and prevents the per-request Server/Transport leak.
    await cleanup()
  }
})

/**
 * Constant-time bearer comparison. Different-length inputs short-circuit to
 * `false` after a dummy compare so the early-return itself does not leak the
 * expected length.
 */
const bearerMatches = (presented: string, expected: string): boolean => {
  const presentedBuf = Buffer.from(presented, "utf8")
  const expectedBuf = Buffer.from(expected, "utf8")
  if (presentedBuf.length !== expectedBuf.length) {
    timingSafeEqual(presentedBuf, presentedBuf)
    return false
  }
  return timingSafeEqual(presentedBuf, expectedBuf)
}
