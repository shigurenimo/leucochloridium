import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Project } from "@/config/config-schema"
import { PromptPreset } from "@/engine/prompt-presets"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"
import { LeucoRuntime } from "@/runtime/runtime"

const PROJECT_ID = "00000000-0000-4000-8000-000000000000"

const sampleProject = (): Project => ({
  version: 2,
  id: PROJECT_ID,
  name: "demo",
  path: "/tmp/demo",
  enabled: true,
  useCommonInstructions: true,
  model: null,
  developerInstructions: null,
  prompts: [PromptPreset.CORE, PromptPreset.WORK_COMMUNICATION, PromptPreset.COMMUNICATION_SLACK],
  channels: [],
  mcpServers: {},
  state: { codexThreadId: null, scheduleLastFiredAt: {} },
})

describe("LeucoRuntime", () => {
  let home = ""

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leuco-runtime-"))
    mkdirSync("/tmp/demo", { recursive: true })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("forces gpt-5.6-terra with xhigh reasoning in generated tenant config", () => {
    const paths = new LeucoPaths({ home })
    const store = new LeucoProjectStore({ paths })
    store.save({
      ...sampleProject(),
      mcpServers: {
        private_api: {
          command: "private-api-mcp",
          args: [],
          env: { PRIVATE_API_TOKEN: "secret-value" },
        },
      },
    })

    const configPath = join(paths.projectHome(PROJECT_ID), "config.toml")
    mkdirSync(paths.projectHome(PROJECT_ID), { recursive: true })
    writeFileSync(configPath, "stale", { mode: 0o644 })

    LeucoRuntime.build({ env: {}, home })

    const configToml = readFileSync(configPath, "utf8")
    expect(configToml).toContain('model = "gpt-5.6-terra"')
    expect(configToml).toContain('model_reasoning_effort = "xhigh"')
    expect(configToml).toContain('approval_policy = "never"')
    expect(configToml).toContain('sandbox_mode = "danger-full-access"')
    expect(configToml).toContain('url = "http://127.0.0.1:7331/mcp/')
    expect(configToml).toContain('PRIVATE_API_TOKEN = "secret-value"')
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
  })
})
