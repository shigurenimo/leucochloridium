import type { McpServer } from "@/config/config-schema"
import { tomlString } from "@/engine/codex/toml-string"

type Props = {
  projectPath: string
  extraMcpServers: Record<string, McpServer>
}

/**
 * Project-owned Codex settings that layer on top of a shared CODEX_HOME.
 * They are process arguments, so Leuco never rewrites the user's config.toml.
 */
export class LeucoCodexConfig {
  constructor(private readonly props: Props) {
    Object.freeze(this)
  }

  toArgs(): string[] {
    const arguments_ = ["app-server"]

    for (const override of this.toOverrides()) {
      arguments_.push("-c", override)
    }

    return arguments_
  }

  private toOverrides(): string[] {
    return [
      `model=${tomlString("gpt-5.6-terra")}`,
      `model_reasoning_effort=${tomlString("xhigh")}`,
      "tool_output_token_limit=20000",
      `approval_policy=${tomlString("never")}`,
      `sandbox_mode=${tomlString("danger-full-access")}`,
      `projects.${tomlString(this.props.projectPath)}.trust_level=${tomlString("trusted")}`,
      ...this.toMcpOverrides(),
    ]
  }

  private toMcpOverrides(): string[] {
    const overrides: string[] = []

    for (const entry of Object.entries(this.props.extraMcpServers)) {
      overrides.push(...this.toMcpServerOverrides(entry[0], entry[1]))
    }

    return overrides
  }

  private toMcpServerOverrides(name: string, server: McpServer): string[] {
    const prefix = `mcp_servers.${name}`
    const args = `[${server.args.map((argument) => tomlString(argument)).join(", ")}]`
    const fields = [`command = ${tomlString(server.command)}`, `args = ${args}`]
    const environment = Object.entries(server.env)
      .map((entry) => `${entry[0]} = ${tomlString(entry[1])}`)
      .join(", ")

    if (environment !== "") fields.push(`env = { ${environment} }`)
    return [`${prefix}={ ${fields.join(", ")} }`]
  }
}
