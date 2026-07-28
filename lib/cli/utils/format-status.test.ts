import { describe, expect, it, vi } from "vitest"
import type { Project } from "@/config/config-schema"
import { formatStatus } from "@/cli/utils/format-status"

const healthyProject: Project = {
  version: 3,
  id: "00000000-0000-4000-8000-000000000001",
  name: "healthy",
  path: "/tmp/healthy",
  enabled: true,
  conversationScope: "project",
  useCommonInstructions: true,
  model: null,
  developerInstructions: null,
  prompts: [],
  connectors: [],
  mcpServers: {},
}

describe("formatStatus", () => {
  it("reports healthy projects and isolates invalid project entries", () => {
    const clearStalePid = vi.fn()
    const daemon = {
      clearStalePid,
      status: () => ({
        pid: 42,
        isRunning: true,
        pidPath: "/tmp/leuco.pid",
        logPath: "/tmp/leuco.log",
      }),
    }
    const projectStore = {
      listRunnable: () => ({
        projects: [healthyProject],
        issues: [{ index: 1, project: "broken", error: "id: invalid UUID" }],
      }),
    }

    const status = formatStatus(daemon, projectStore)

    expect(status.isRunning).toBe(true)
    expect(status.text).toContain("name: healthy")
    expect(status.text).toContain("projectIssues:")
    expect(status.text).toContain("project: broken")
    expect(status.text).toContain('error: "id: invalid UUID"')
    expect(clearStalePid).not.toHaveBeenCalled()
  })
})
