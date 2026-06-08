import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { errorMessage } from "@/error-message"
import { buildMcpServer } from "@/mcp/build-mcp-server"
import { LeucoProjectStore } from "@/projects/project-store"

type Props = {
  projectName: string
  agentName: string
}

/**
 * stdio-MCP entry. Spawned by codex via `[mcp_servers.leuco] command = "leuco"
 * args = ["mcp", "--project", "<name>", "--agent", "<a>"]`. Kept for backwards
 * compatibility — the daemon's HTTP MCP route at `/mcp/<id>/<a>` is preferred
 * because it avoids one MCP child per tenant.
 *
 * Accepts the human-readable project `name` (the user-typed identifier) and
 * resolves it to the on-disk project `id` before building the server. When
 * the name maps to multiple projects, the caller has to use the HTTP route.
 */
export const startMcpServer = async (props: Props): Promise<void> => {
  const store = new LeucoProjectStore()

  // `resolveByName` throws — the old `instanceof Error` guard was dead and
  // any failure (project not found, ambiguous name) crashed the stdio child
  // with no stderr line for codex to surface.
  let projectId: string
  try {
    projectId = store.resolveByName(props.projectName).id
  } catch (error) {
    process.stderr.write(`leuco mcp: ${errorMessage(error)}\n`)
    process.exit(2)
  }

  const server = buildMcpServer({
    projectId,
    agentName: props.agentName,
    store,
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
