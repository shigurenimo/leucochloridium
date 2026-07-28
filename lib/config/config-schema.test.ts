import { describe, expect, it } from "vitest"
import { projectSchema } from "@/config/config-schema"
import { PromptPreset } from "@/prompts/presets"

describe("projectSchema", () => {
  it("migrates version 2 channels into version 3 connectors", () => {
    const parsed = projectSchema.parse({
      version: 2,
      id: "00000000-0000-4000-8000-000000000000",
      name: "demo",
      path: "/tmp/demo",
      channels: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "schedule",
          type: "schedule",
        },
      ],
    })

    expect(parsed.version).toBe(3)
    expect(parsed.connectors).toEqual([
      expect.objectContaining({ name: "schedule", type: "schedule" }),
    ])
    expect("channels" in parsed).toBe(false)
  })

  it("defaults Slack ack reactions to mentions", () => {
    const parsed = projectSchema.parse({
      version: 3,
      id: "00000000-0000-4000-8000-000000000000",
      name: "demo",
      path: "/tmp/demo",
      connectors: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "slack",
          type: "slack",
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
      ],
    })

    expect(parsed.connectors[0]).toMatchObject({
      type: "slack",
      ackMode: "mention",
      ackIcons: {
        progress: "hourglass_flowing_sand",
        success: "white_check_mark",
        error: "x",
      },
    })
    expect(parsed.conversationScope).toBe("project")
    expect("state" in parsed).toBe(false)
  })

  it("accepts thread-scoped conversations and strips legacy runtime state", () => {
    const parsed = projectSchema.parse({
      version: 3,
      id: "00000000-0000-4000-8000-000000000000",
      name: "demo",
      path: "/tmp/demo",
      conversationScope: "thread",
      state: {
        codexThreadIds: {
          "slack:C1:T1": "codex-thread-1",
        },
      },
    })

    expect(parsed.conversationScope).toBe("thread")
    expect("state" in parsed).toBe(false)
  })

  it("migrates the legacy friendly prompt preset", () => {
    const parsed = projectSchema.parse({
      version: 3,
      id: "00000000-0000-4000-8000-000000000000",
      name: "demo",
      path: "/tmp/demo",
      prompts: ["friendly"],
      connectors: [],
    })

    expect(parsed.prompts).toEqual([
      PromptPreset.CORE,
      PromptPreset.SECURITY,
      PromptPreset.ROLE_PROJECT_MANAGEMENT,
      PromptPreset.STYLE_WORK,
      PromptPreset.STYLE_HUMAN,
      PromptPreset.STYLE_SLACK,
      PromptPreset.AGENTS_MEMORY,
    ])
  })

  it.each([
    ["COMMUNICATION", PromptPreset.STYLE_WORK],
    ["WORK_COMMUNICATION", PromptPreset.STYLE_WORK],
    ["HUMAN_COMMUNICATION", PromptPreset.STYLE_HUMAN],
    ["COMMUNICATION_SLACK", PromptPreset.STYLE_SLACK],
  ])("migrates legacy prompt preset %s to %s", (legacy, current) => {
    const parsed = projectSchema.parse({
      version: 3,
      id: "00000000-0000-4000-8000-000000000000",
      name: "demo",
      path: "/tmp/demo",
      prompts: [legacy, current],
      connectors: [],
    })

    expect(parsed.prompts).toEqual([current])
  })
})
