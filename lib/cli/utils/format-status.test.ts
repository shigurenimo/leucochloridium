import { describe, expect, it } from "vitest"
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
    const daemon = {
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
  })

  it("reports stale status without requiring a destructive cleanup operation", () => {
    const daemon = {
      status: () => ({
        pid: 42,
        isRunning: false,
        pidPath: "/tmp/leuco.pid",
        logPath: "/tmp/leuco.log",
      }),
    }
    const projectStore = {
      listRunnable: () => ({ projects: [], issues: [] }),
    }

    const status = formatStatus(daemon, projectStore)

    expect(status.isRunning).toBe(false)
    expect(status.text).not.toContain("pid:")
  })
})
