import { describe, expect, it } from "vitest"
import { projectSchema } from "@/config/config-schema"

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
})
