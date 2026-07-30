import { describe, expect, it } from "vitest"
import type { Project } from "@/config/config-schema"
import { isCurrentCodexProject, selfProjectGuardMessage } from "@/cli/utils/self-project-guard"

const project: Project = {
  version: 3,
  id: "45ec9e03-5da4-4566-aa82-143cc38b8df5",
  name: "azamino",
  path: "/Users/i/inta",
  enabled: true,
  conversationScope: "project",
  connectors: [],
  prompts: [],
  useCommonInstructions: true,
  model: null,
  developerInstructions: null,
  mcpServers: {},
}

describe("isCurrentCodexProject", () => {
  it("uses LEUCO_PROJECT_ID when CODEX_HOME is shared", () => {
    expect(
      isCurrentCodexProject(project, {
        CODEX_HOME: "/Users/i/.codex",
        LEUCO_PROJECT_ID: project.id,
      }),
    ).toBe(true)
  })

  it("rejects another LEUCO_PROJECT_ID even when CODEX_HOME is shared", () => {
    expect(
      isCurrentCodexProject(project, {
        CODEX_HOME: "/Users/i/.codex",
        LEUCO_PROJECT_ID: "1418d059-f8c6-45a1-9483-94e10ca8da9e",
      }),
    ).toBe(false)
  })

  it("returns true when CODEX_HOME points at the project's codex home", () => {
    expect(
      isCurrentCodexProject(project, {
        CODEX_HOME: "/Users/i/.leuco/projects/45ec9e03-5da4-4566-aa82-143cc38b8df5/.codex/",
      }),
    ).toBe(true)
  })

  it("returns false when CODEX_HOME points at another project", () => {
    expect(
      isCurrentCodexProject(project, {
        CODEX_HOME: "/Users/i/.leuco/projects/1418d059-f8c6-45a1-9483-94e10ca8da9e/.codex",
      }),
    ).toBe(false)
  })

  it("returns false outside a codex-managed process", () => {
    expect(isCurrentCodexProject(project, {})).toBe(false)
  })
})

describe("selfProjectGuardMessage", () => {
  it("names the blocked action and project", () => {
    expect(selfProjectGuardMessage("azamino", "reset")).toContain(
      'refusing to reset project "azamino"',
    )
  })
})
