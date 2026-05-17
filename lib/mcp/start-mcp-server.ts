import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
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
  const project = store.resolveByName(props.projectName)
  if (project instanceof Error) {
    process.stderr.write(`leuco mcp: ${project.message}\n`)
    process.exit(2)
  }

  const server = buildMcpServer({
    projectId: project.id,
    agentName: props.agentName,
    store,
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
