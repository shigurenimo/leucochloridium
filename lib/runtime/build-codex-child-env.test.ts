import { describe, expect, it } from "vitest"
import { buildCodexChildEnv } from "@/runtime/build-codex-child-env"

describe("native Codex environment", () => {
  it("does not inherit Slack token environment variables into Codex", () => {
    expect(
      buildCodexChildEnv({
        env: {
          SLACK_BOT_TOKEN: "secret",
          SLACK_APP_TOKEN: "secret",
          LEUCO_SLACK_BOT_TOKEN: "secret",
          LEUCO_SLACK_APP_TOKEN: "secret",
          PATH: "/bin",
        },
        home: "/state",
      }),
    ).toEqual({ LEUCO_HOME: "/state", PATH: "/bin" })
  })
  it("leaves CODEX_HOME absent so Codex uses its own default", () => {
    const env = buildCodexChildEnv({ env: { PATH: "/bin" }, home: "/state" })
    expect(env).toEqual({ PATH: "/bin", LEUCO_HOME: "/state" })
    expect(Object.hasOwn(env, "CODEX_HOME")).toBe(false)
  })
  it("preserves an explicit Codex home without copying settings or auth", () => {
    const original = { CODEX_HOME: "/native", LEUCO_PROJECT_ID: "obsolete" }
    expect(buildCodexChildEnv({ env: original, home: "/state" })).toEqual({
      CODEX_HOME: "/native",
      LEUCO_HOME: "/state",
    })
    expect(original.LEUCO_PROJECT_ID).toBe("obsolete")
  })
})
