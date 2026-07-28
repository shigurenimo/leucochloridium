import type { Project } from "@/config/config-schema"

/**
 * Stable fingerprint of every project field a project runtime build bakes in: path,
 * prompt config, model, mcpServers, and each enabled connector's settings
 * (tokens, ackMode, …). Reconcile compares it to decide whether a running
 * project runtime must be rebuilt — comparing only the connector-name set would keep a
 * runtime on stale Slack tokens after `set-tokens`, or on a stale cwd after
 * `cwd`.
 *
 * Schedule connector `entries` are deliberately excluded: the connector
 * re-reads them from settings.json on every tick, so entry churn (including
 * one-shot deletion after fire) must not restart the whole project runtime.
 */
export const projectRuntimeSignature = (project: Project): string => {
  const connectors = project.connectors
    .filter((connector) => connector.enabled)
    .map((connector) => {
      if (connector.type === "schedule") {
        return { id: connector.id, name: connector.name, type: connector.type }
      }
      return connector
    })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))

  const mcpServers = Object.entries(project.mcpServers).sort((a, b) => a[0].localeCompare(b[0]))

  return JSON.stringify({
    name: project.name,
    path: project.path,
    conversationScope: project.conversationScope,
    useCommonInstructions: project.useCommonInstructions,
    model: project.model,
    developerInstructions: project.developerInstructions,
    prompts: project.prompts,
    mcpServers,
    connectors,
  })
}
