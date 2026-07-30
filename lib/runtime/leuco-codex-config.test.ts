import { describe, expect, it } from "vitest"
import { LeucoCodexConfig } from "@/runtime/leuco-codex-config"

describe("LeucoCodexConfig", () => {
  it("layers project settings over the shared CODEX_HOME config", () => {
    const config = new LeucoCodexConfig({
      projectPath: '/work/quoted "project"',
      extraMcpServers: {
        private_api: {
          command: "private-api-mcp",
          args: ["--scope", "採用"],
          env: { PRIVATE_API_TOKEN: "secret\nvalue" },
        },
      },
    })

    expect(config.toArgs()).toEqual([
      "app-server",
      "-c",
      'model="gpt-5.6-terra"',
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      "tool_output_token_limit=20000",
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'projects."/work/quoted \\"project\\"".trust_level="trusted"',
      "-c",
      'mcp_servers.private_api={ command = "private-api-mcp", args = ["--scope", "採用"], env = { PRIVATE_API_TOKEN = "secret\\nvalue" } }',
    ])
  })

  it("does not replace unrelated user configuration", () => {
    const config = new LeucoCodexConfig({
      projectPath: "/work/demo",
      extraMcpServers: {},
    })

    expect(config.toArgs().join("\n")).not.toContain("plugins")
    expect(config.toArgs().join("\n")).not.toContain("features")
    expect(config.toArgs().join("\n")).not.toContain("notify")
  })
})
