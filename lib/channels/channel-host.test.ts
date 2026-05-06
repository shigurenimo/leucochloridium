import { describe, expect, it } from "vitest"
import { LeucoChannelHost } from "@/channels/channel-host"
import { LeucoSlackChannelPlugin } from "@/channels/slack/slack-channel-plugin"
import type { Agent, Channel } from "@/config/config-schema"

const slackChannel = (
  name: string,
  botToken = "xoxb-1",
  appToken = "xapp-1",
): Channel => ({
  id: "11111111-1111-4111-8111-111111111111",
  name,
  type: "slack",
  enabled: true,
  botToken,
  appToken,
  ackMode: "mention",
  ackIcons: {
    progress: "hourglass_flowing_sand",
    success: "white_check_mark",
    error: "x",
  },
})

const agent = (channels: Agent["channels"]): Agent => ({
  name: "default",
  enabled: true,
  channels,
})

describe("LeucoChannelHost.buildForAgent", () => {
  it("returns no plugins for an agent with no channels", () => {
    const plugins = LeucoChannelHost.buildForAgent({
      projectName: "demo",
      agent: agent([]),
    })
    expect(plugins).toEqual([])
  })

  it("builds a LeucoSlackChannelPlugin when both tokens are present", () => {
    const plugins = LeucoChannelHost.buildForAgent({
      projectName: "demo",
      agent: agent([slackChannel("main")]),
    })
    expect(plugins).not.toBeInstanceOf(Error)
    if (plugins instanceof Error) return
    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toBeInstanceOf(LeucoSlackChannelPlugin)
    expect(plugins[0]?.name).toBe("main")
  })

  it("returns Error when bot token is empty", () => {
    const result = LeucoChannelHost.buildForAgent({
      projectName: "demo",
      agent: agent([slackChannel("main", "", "xapp-1")]),
    })
    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toContain("botToken")
    }
  })

  it("returns Error when app token is empty", () => {
    const result = LeucoChannelHost.buildForAgent({
      projectName: "demo",
      agent: agent([slackChannel("main", "xoxb-1", "")]),
    })
    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toContain("appToken")
    }
  })

  it("stops at the first failing channel", () => {
    const result = LeucoChannelHost.buildForAgent({
      projectName: "demo",
      agent: agent([slackChannel("ok"), slackChannel("missing", "", "")]),
    })
    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toContain("missing")
    }
  })
})
