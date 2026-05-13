import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { buildMcpServer } from "@/mcp/build-mcp-server"

type Props = {
  projectName: string
  agentName: string
}

/**
 * stdio-MCP entry. Spawned by codex via `[mcp_servers.leuco] command = "leuco"
 * args = ["mcp", "--project", "<p>", "--agent", "<a>"]`. Kept for backwards
 * compatibility — the daemon's HTTP MCP route at `/mcp/<p>/<a>` is preferred
 * because it avoids one MCP child per tenant.
 */
export const startMcpServer = async (props: Props): Promise<void> => {
  const server = buildMcpServer({
    projectName: props.projectName,
    agentName: props.agentName,
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
