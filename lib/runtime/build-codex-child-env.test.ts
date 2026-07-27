import { describe, expect, it } from "vitest"
import { buildCodexChildEnv } from "@/runtime/build-codex-child-env"

describe("buildCodexChildEnv", () => {
  it("replaces inherited tenant identity with the current project", () => {
    const env = buildCodexChildEnv({
      env: {
        PATH: "/usr/bin",
        CODEX_HOME: "/wrong/codex-home",
        LEUCO_PROJECT_ID: "00000000-0000-4000-8000-000000000001",
      },
      codexHome: "/tenant/codex-home",
      projectId: "00000000-0000-4000-8000-000000000002",
    })

    expect(env).toEqual({
      PATH: "/usr/bin",
      CODEX_HOME: "/tenant/codex-home",
      LEUCO_PROJECT_ID: "00000000-0000-4000-8000-000000000002",
    })
  })
})
