import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { errorMessage } from "@/error-message"
import { buildMcpServer } from "@/mcp/build-mcp-server"
import { LeucoProjectStore } from "@/projects/project-store"

type Props = {
  projectName: string
}

/**
 * stdio-MCP entry. Spawned by codex via `[mcp_servers.leuco] command = "leuco"
 * args = ["mcp", "--project", "<name>"]`. Kept for backwards compatibility —
 * the daemon's HTTP MCP route at `/mcp/<id>` is preferred because it avoids
 * one MCP child per tenant.
 */
export const startMcpServer = async (props: Props): Promise<void> => {
  const store = new LeucoProjectStore()

  let projectId: string
  try {
    projectId = store.resolveByName(props.projectName).id
  } catch (error) {
    process.stderr.write(`leuco mcp: ${errorMessage(error)}\n`)
    process.exit(2)
  }

  const server = buildMcpServer({ projectId, store })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
