import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { LeucoConnectorHost } from "@/connectors/connector-host"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import type { ConnectorConfig, Project } from "@/config/config-schema"
import { PromptPreset } from "@/prompts/presets"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStateStore } from "@/projects/project-state-store"
import { LeucoProjectStore } from "@/projects/project-store"

const slackChannel = (name: string, botToken = "xoxb-1", appToken = "xapp-1"): ConnectorConfig => ({
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

describe("LeucoConnectorHost.buildForProject", () => {
  it("returns no connectors for a project with no connectors", () => {
    const connectors = LeucoConnectorHost.buildForProject({
      project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
      connectors: [],
    })
    expect(connectors).toEqual([])
  })

  it("builds a LeucoSlackConnector when both tokens are present", () => {
    const connectors = LeucoConnectorHost.buildForProject({
      project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
      connectors: [slackChannel("main")],
    })
    expect(connectors).toHaveLength(1)
    expect(connectors[0]).toBeInstanceOf(LeucoSlackConnector)
    expect(connectors[0]?.name).toBe("main")
  })

  it("throws when bot token is empty", () => {
    expect(() =>
      LeucoConnectorHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        connectors: [slackChannel("main", "", "xapp-1")],
      }),
    ).toThrow(/botToken/)
  })

  it("throws when app token is empty", () => {
    expect(() =>
      LeucoConnectorHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        connectors: [slackChannel("main", "xoxb-1", "")],
      }),
    ).toThrow(/appToken/)
  })

  it("accepts a user OAuth token for user-mode Slack operation", () => {
    const connectors = LeucoConnectorHost.buildForProject({
      project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
      connectors: [slackChannel("main", "xoxp-1", "xapp-1")],
    })
    expect(connectors).toHaveLength(1)
  })

  it("throws when the Slack access token is neither bot nor user token", () => {
    expect(() =>
      LeucoConnectorHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        connectors: [slackChannel("main", "xoxa-1", "xapp-1")],
      }),
    ).toThrow(/botToken must start with xoxb- or xoxp-/)
  })

  it("throws when the app token is not an app-level token", () => {
    expect(() =>
      LeucoConnectorHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        connectors: [slackChannel("main", "xoxb-1", "xoxb-2")],
      }),
    ).toThrow(/appToken must start with xapp-/)
  })

  it("stops at the first failing connector", () => {
    expect(() =>
      LeucoConnectorHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        connectors: [slackChannel("ok"), slackChannel("missing", "", "")],
      }),
    ).toThrow(/missing/)
  })

  it("builds a LeucoScheduleConnector when projectStore is provided", () => {
    const home = mkdtempSync(join(tmpdir(), "leuco-connector-host-"))
    try {
      const paths = new LeucoPaths({ home })
      const store = new LeucoProjectStore({ paths })
      const project: Project = {
        version: 3,
        id: "00000000-0000-4000-8000-000000000000",
        name: "demo",
        path: "/tmp/demo",
        enabled: true,
        conversationScope: "project",
        useCommonInstructions: true,
        model: null,
        developerInstructions: null,
        prompts: [PromptPreset.CORE, PromptPreset.STYLE_WORK, PromptPreset.STYLE_SLACK],
        connectors: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            name: "cron",
            type: "schedule",
            enabled: true,
            entries: [],
          },
        ],
        mcpServers: {},
      }
      store.save(project)

      const stateStore = new LeucoProjectStateStore({ paths: store.getPaths() })
      const connectors = LeucoConnectorHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        connectors: project.connectors,
        projectStore: store,
        projectStateStore: stateStore,
      })
      expect(connectors).toHaveLength(1)
      expect(connectors[0]).toBeInstanceOf(LeucoScheduleConnector)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("throws when a schedule connector is built without a projectStore", () => {
    const scheduleChannel: ConnectorConfig = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "cron",
      type: "schedule",
      enabled: true,
      entries: [],
    }
    expect(() =>
      LeucoConnectorHost.buildForProject({
        project: { id: "00000000-0000-4000-8000-000000000000", name: "demo" },
        connectors: [scheduleChannel],
      }),
    ).toThrow(/projectStore/)
  })
})
