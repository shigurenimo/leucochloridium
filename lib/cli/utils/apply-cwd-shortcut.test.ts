import { describe, expect, it } from "vitest"
import type { Project } from "@/config/config-schema"
import { applyCwdShortcut } from "@/cli/utils/apply-cwd-shortcut"
import { LeucoProjectStore } from "@/projects/project-store"

const scopedProject: Project = {
  version: 3,
  id: "45ec9e03-5da4-4566-aa82-143cc38b8df5",
  name: "demo",
  path: "/tmp/demo",
  enabled: true,
  conversationScope: "project",
  connectors: [],
  prompts: [],
  useCommonInstructions: true,
  model: null,
  developerInstructions: null,
  mcpServers: {},
}

describe("applyCwdShortcut", () => {
  it("uses the runtime scope even after the shell changes directories", () => {
    const args = applyCwdShortcut({
      args: ["connectors", "cron", "schedules", "list"],
      cwd: "/tmp/a-different-project",
      projectStore: new LeucoProjectStore(),
      scopedProject,
    })

    expect(args).toEqual(["projects", "demo", "connectors", "cron", "schedules", "list"])
  })
})
