import { describe, expect, it } from "vitest"
import type { Project } from "@/config/config-schema"
import { applyCwdShortcut } from "@/cli/utils/apply-cwd-shortcut"
import { LeucoProjectStore } from "@/projects/project-store"

const scopedProject: Project = {
  version: 2,
  id: "45ec9e03-5da4-4566-aa82-143cc38b8df5",
  name: "demo",
  path: "/tmp/demo",
  enabled: true,
  conversationScope: "project",
  channels: [],
  prompts: [],
  useCommonInstructions: true,
  model: null,
  developerInstructions: null,
  mcpServers: {},
  state: { codexThreadId: null, codexThreadIds: {}, scheduleLastFiredAt: {} },
}

describe("applyCwdShortcut", () => {
  it("uses the tenant scope even after the shell changes directories", () => {
    const args = applyCwdShortcut({
      args: ["channels", "cron", "schedules", "list"],
      cwd: "/tmp/a-different-project",
      projectStore: new LeucoProjectStore(),
      scopedProject,
    })

    expect(args).toEqual(["projects", "demo", "channels", "cron", "schedules", "list"])
  })
})
