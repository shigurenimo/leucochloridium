import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { factory } from "@/cli/cli-factory"
import type { Project } from "@/config/config-schema"
import { resolveProject } from "@/cli/utils/lookup-config"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const project: Project = {
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

describe("resolveProject", () => {
  it("uses the scoped project id even when cwd matches a duplicate name", async () => {
    const home = mkdtempSync(join(tmpdir(), "leuco-project-scope-"))
    try {
      const store = new LeucoProjectStore({ paths: new LeucoPaths({ home }) })
      const duplicate: Project = {
        ...project,
        id: "00000000-0000-4000-8000-000000000002",
        path: "/tmp/duplicate",
      }
      store.save(project)
      store.save(duplicate)

      const app = factory.createApp()
      app.use((context, next) => {
        context.set("cwd", duplicate.path)
        context.set("projectIdScope", project.id)
        return next()
      })
      app.command("/:project", (context) => {
        const resolved = resolveProject(context, store, context.req.param("project"))
        return context.json({ id: resolved.id })
      })

      const sameName = await app.dispatch({ path: "/demo" })
      expect(sameName.status).toBe(200)
      expect(await sameName.json()).toEqual({ id: project.id })

      const otherName = await app.dispatch({ path: "/another-project" })
      expect(otherName.status).toBe(403)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
