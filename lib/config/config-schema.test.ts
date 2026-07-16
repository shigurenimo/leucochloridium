import { describe, expect, it } from "vitest"
import { projectSchema } from "@/config/config-schema"
import { PromptPreset } from "@/prompts/presets"

describe("projectSchema", () => {
  it("defaults Slack ack reactions to off", () => {
    const parsed = projectSchema.parse({
      version: 2,
      id: "00000000-0000-4000-8000-000000000000",
      name: "demo",
      path: "/tmp/demo",
      channels: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "slack",
          type: "slack",
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
      ],
    })

    expect(parsed.channels[0]).toMatchObject({
      type: "slack",
      ackMode: "off",
      ackIcons: {
        progress: "hourglass_flowing_sand",
        success: "white_check_mark",
        error: "x",
      },
    })
  })

  it("migrates the legacy friendly prompt preset", () => {
    const parsed = projectSchema.parse({
      version: 2,
      id: "00000000-0000-4000-8000-000000000000",
      name: "demo",
      path: "/tmp/demo",
      prompts: ["friendly"],
      channels: [],
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
      version: 2,
      id: "00000000-0000-4000-8000-000000000000",
      name: "demo",
      path: "/tmp/demo",
      prompts: [legacy, current],
      channels: [],
    })

    expect(parsed.prompts).toEqual([current])
  })
})
