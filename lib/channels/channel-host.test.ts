import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { LeucoChannelHost } from "@/channels/channel-host"
import { LeucoScheduleChannelPlugin } from "@/channels/schedule/schedule-channel-plugin"
import { LeucoSlackChannelPlugin } from "@/channels/slack/slack-channel-plugin"
import type { Agent, Channel, Project } from "@/config/config-schema"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoAgentStateStore } from "@/projects/agent-state-store"
import { LeucoProjectStore } from "@/projects/project-store"

const slackChannel = (name: string, botToken = "xoxb-1", appToken = "xapp-1"): Channel => ({
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
  useCommonInstructions: true,
  prompts: ["friendly"],
  channels,
})

describe("LeucoChannelHost.buildForAgent", () => {
  it("returns no plugins for an agent with no channels", () => {
    const plugins = LeucoChannelHost.buildForAgent({
      project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
      agent: agent([]),
    })
    expect(plugins).toEqual([])
  })

  it("builds a LeucoSlackChannelPlugin when both tokens are present", () => {
    const plugins = LeucoChannelHost.buildForAgent({
      project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
      agent: agent([slackChannel("main")]),
    })
    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toBeInstanceOf(LeucoSlackChannelPlugin)
    expect(plugins[0]?.name).toBe("main")
  })

  it("throws when bot token is empty", () => {
    expect(() =>
      LeucoChannelHost.buildForAgent({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        agent: agent([slackChannel("main", "", "xapp-1")]),
      }),
    ).toThrow(/botToken/)
  })

  it("throws when app token is empty", () => {
    expect(() =>
      LeucoChannelHost.buildForAgent({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        agent: agent([slackChannel("main", "xoxb-1", "")]),
      }),
    ).toThrow(/appToken/)
  })

  it("stops at the first failing channel", () => {
    expect(() =>
      LeucoChannelHost.buildForAgent({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        agent: agent([slackChannel("ok"), slackChannel("missing", "", "")]),
      }),
    ).toThrow(/missing/)
  })

  it("builds a LeucoScheduleChannelPlugin when projectStore is provided", () => {
    const home = mkdtempSync(join(tmpdir(), "leuco-channel-host-"))
    try {
      const store = new LeucoProjectStore({ paths: new LeucoPaths({ home }) })
      const project: Project = {
        id: "00000000-0000-4000-8000-000000000000",
        name: "demo",
        path: "/tmp/demo",
        agents: [
          {
            name: "default",
            enabled: true,
            useCommonInstructions: true,
            prompts: ["friendly"],
            channels: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                name: "cron",
                type: "schedule",
                enabled: true,
                entries: [],
              },
            ],
          },
        ],
      }
      store.save(project)

      const stateStore = new LeucoAgentStateStore({ paths: new LeucoPaths({ home }) })
      const plugins = LeucoChannelHost.buildForAgent({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        agent: project.agents[0]!,
        projectStore: store,
        agentStateStore: stateStore,
      })
      expect(plugins).toHaveLength(1)
      expect(plugins[0]).toBeInstanceOf(LeucoScheduleChannelPlugin)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("throws when a schedule channel is built without a projectStore", () => {
    const scheduleChannel: Channel = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "cron",
      type: "schedule",
      enabled: true,
      entries: [],
    }
    expect(() =>
      LeucoChannelHost.buildForAgent({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        agent: agent([scheduleChannel]),
      }),
    ).toThrow(/projectStore/)
  })
})
