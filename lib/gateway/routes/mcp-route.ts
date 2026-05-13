import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { factory } from "@/gateway/gateway-factory"
import { buildMcpServer } from "@/mcp/build-mcp-server"

/**
 * Streamable HTTP MCP endpoint at `/mcp/:project/:agent`. Codex tenants point
 * their `[mcp_servers.leuco]` here via the daemon-wide bearer token (written
 * into each tenant's CODEX_HOME config.toml as `bearer_token_env_var`); this
 * replaces the per-tenant `leuco mcp` stdio child and removes the orphan-MCP
 * failure mode entirely.
 *
 * Stateless mode (`sessionIdGenerator: undefined`) + a freshly built `Server`
 * per request: tools are stateless and the per-request cost is trivial, so we
 * skip session bookkeeping rather than tracking transport instances per
 * (project, agent) pair across restarts.
 */
export const mcpHandler = factory.createHandlers(async (c) => {
  const deps = c.var.deps
  if (deps.mcpToken === null) return c.text("mcp endpoint disabled", 503)

  const header = c.req.header("authorization") ?? ""
  const presented = header.startsWith("Bearer ") ? header.slice(7) : ""
  if (presented !== deps.mcpToken) return c.text("unauthorized", 401)

  const projectName = c.req.param("project")
  const agentName = c.req.param("agent")
  if (!projectName || !agentName) return c.text("project and agent required", 400)

  const server = buildMcpServer({ projectName, agentName })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)

  const response = await transport.handleRequest(c.req.raw)
  c.req.raw.signal.addEventListener("abort", () => {
    void transport.close().catch(() => undefined)
    void server.close().catch(() => undefined)
  })
  return response
})
