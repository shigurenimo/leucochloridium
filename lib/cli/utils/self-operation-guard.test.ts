import { afterEach, describe, expect, it } from "vitest"
import { isSelfAgentOperation, selfAgentOperationMessage } from "@/cli/utils/self-operation-guard"

const originalProject = process.env.LEUCO_PROJECT_NAME
const originalAgent = process.env.LEUCO_AGENT_NAME

afterEach(() => {
  if (originalProject === undefined) {
    delete process.env.LEUCO_PROJECT_NAME
  } else {
    process.env.LEUCO_PROJECT_NAME = originalProject
  }
  if (originalAgent === undefined) {
    delete process.env.LEUCO_AGENT_NAME
  } else {
    process.env.LEUCO_AGENT_NAME = originalAgent
  }
})

describe("self-operation guard", () => {
  it("detects operations targeting the current leuco agent", () => {
    process.env.LEUCO_PROJECT_NAME = "azamino"
    process.env.LEUCO_AGENT_NAME = "azamino"

    expect(isSelfAgentOperation("azamino", "azamino")).toBe(true)
    expect(isSelfAgentOperation("azamino", "other")).toBe(false)
    expect(isSelfAgentOperation("other", "azamino")).toBe(false)
  })

  it("returns a clear refusal message", () => {
    expect(selfAgentOperationMessage("reset", "azamino", "azamino")).toBe(
      "refusing to reset current agent azamino/azamino from inside its own Codex turn; run it from an external shell",
    )
  })
})
