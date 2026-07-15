import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { LeucoChannelHost } from "@/channels/channel-host"
import { LeucoScheduleChannelPlugin } from "@/channels/schedule/schedule-channel-plugin"
import { LeucoSlackChannelPlugin } from "@/channels/slack/slack-channel-plugin"
import type { Channel, Project } from "@/config/config-schema"
import { PromptPreset } from "@/engine/prompt-presets"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStateStore } from "@/projects/project-state-store"
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

describe("LeucoChannelHost.buildForProject", () => {
  it("returns no plugins for a project with no channels", () => {
    const plugins = LeucoChannelHost.buildForProject({
      project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
      channels: [],
    })
    expect(plugins).toEqual([])
  })

  it("builds a LeucoSlackChannelPlugin when both tokens are present", () => {
    const plugins = LeucoChannelHost.buildForProject({
      project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
      channels: [slackChannel("main")],
    })
    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toBeInstanceOf(LeucoSlackChannelPlugin)
    expect(plugins[0]?.name).toBe("main")
  })

  it("throws when bot token is empty", () => {
    expect(() =>
      LeucoChannelHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        channels: [slackChannel("main", "", "xapp-1")],
      }),
    ).toThrow(/botToken/)
  })

  it("throws when app token is empty", () => {
    expect(() =>
      LeucoChannelHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        channels: [slackChannel("main", "xoxb-1", "")],
      }),
    ).toThrow(/appToken/)
  })

  it("accepts a user OAuth token for user-mode Slack operation", () => {
    const plugins = LeucoChannelHost.buildForProject({
      project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
      channels: [slackChannel("main", "xoxp-1", "xapp-1")],
    })
    expect(plugins).toHaveLength(1)
  })

  it("throws when the Slack access token is neither bot nor user token", () => {
    expect(() =>
      LeucoChannelHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        channels: [slackChannel("main", "xoxa-1", "xapp-1")],
      }),
    ).toThrow(/botToken must start with xoxb- or xoxp-/)
  })

  it("throws when the app token is not an app-level token", () => {
    expect(() =>
      LeucoChannelHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        channels: [slackChannel("main", "xoxb-1", "xoxb-2")],
      }),
    ).toThrow(/appToken must start with xapp-/)
  })

  it("stops at the first failing channel", () => {
    expect(() =>
      LeucoChannelHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        channels: [slackChannel("ok"), slackChannel("missing", "", "")],
      }),
    ).toThrow(/missing/)
  })

  it("builds a LeucoScheduleChannelPlugin when projectStore is provided", () => {
    const home = mkdtempSync(join(tmpdir(), "leuco-channel-host-"))
    try {
      const paths = new LeucoPaths({ home })
      const store = new LeucoProjectStore({ paths })
      const project: Project = {
        version: 2,
        id: "00000000-0000-4000-8000-000000000000",
        name: "demo",
        path: "/tmp/demo",
        enabled: true,
        useCommonInstructions: true,
        model: null,
        developerInstructions: null,
        prompts: [
          PromptPreset.CORE,
          PromptPreset.WORK_COMMUNICATION,
          PromptPreset.COMMUNICATION_SLACK,
        ],
        channels: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            name: "cron",
            type: "schedule",
            enabled: true,
            entries: [],
          },
        ],
        mcpServers: {},
        state: { codexThreadId: null, scheduleLastFiredAt: {} },
      }
      store.save(project)

      const stateStore = new LeucoProjectStateStore({ projectStore: store })
      const plugins = LeucoChannelHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        channels: project.channels,
        projectStore: store,
        projectStateStore: stateStore,
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
      LeucoChannelHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        channels: [scheduleChannel],
      }),
    ).toThrow(/projectStore/)
  })
})
