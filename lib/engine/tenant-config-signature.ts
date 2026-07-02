import type { Project } from "@/config/config-schema"

/**
 * Stable fingerprint of every project field a tenant build bakes in: path,
 * prompt config, model, mcpServers, and each enabled channel's settings
 * (tokens, ackMode, …). Reconcile compares it to decide whether a running
 * tenant must be rebuilt — comparing only the channel-name set would keep a
 * tenant on stale Slack tokens after `set-tokens`, or on a stale cwd after
 * `relocate`.
 *
 * Schedule channel `entries` are deliberately excluded: the schedule plugin
 * re-reads them from settings.json on every tick, so entry churn (including
 * one-shot deletion after fire) must not restart the whole tenant.
 */
export const tenantConfigSignature = (project: Project): string => {
  const channels = project.channels
    .filter((channel) => channel.enabled)
    .map((channel) => {
      if (channel.type === "schedule") {
        return { id: channel.id, name: channel.name, type: channel.type }
      }
      return channel
    })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))

  const mcpServers = Object.entries(project.mcpServers).sort((a, b) => a[0].localeCompare(b[0]))

  return JSON.stringify({
    name: project.name,
    path: project.path,
    useCommonInstructions: project.useCommonInstructions,
    model: project.model,
    developerInstructions: project.developerInstructions,
    prompts: project.prompts,
    mcpServers,
    channels,
  })
}
