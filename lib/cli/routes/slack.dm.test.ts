import { describe, expect, it } from "vitest"
import { buildSlackDmRuntimeSummary } from "@/cli/routes/slack.dm"
import type { LeucoEvent } from "@/events/leuco-event-types"

describe("buildSlackDmRuntimeSummary", () => {
  it("includes daemon state and the target channel's newest connection state", () => {
    const events: LeucoEvent[] = [
      {
        ts: 100,
        type: "slack.connection",
        project: "demo",
        channel: "other",
        status: "disconnected",
      },
      {
        ts: 200,
        type: "slack.connection",
        project: "demo",
        channel: "slack",
        status: "connecting",
      },
      {
        ts: 300,
        type: "slack.connection",
        project: "demo",
        channel: "slack",
        status: "connected",
      },
    ]

    expect(
      buildSlackDmRuntimeSummary({
        daemonRunning: true,
        slackChannel: "slack",
        selection: "latest",
        events,
      }),
    ).toEqual({
      daemonRunning: true,
      slackChannel: "slack",
      slackConnection: "connected",
      slackConnectionObservedAt: 300,
      selection: "latest",
    })
  })

  it("reports unavailable when no connection event has been recorded", () => {
    expect(
      buildSlackDmRuntimeSummary({
        daemonRunning: false,
        slackChannel: "slack",
        selection: "explicit",
        events: [],
      }),
    ).toEqual({
      daemonRunning: false,
      slackChannel: "slack",
      slackConnection: "unavailable",
      slackConnectionObservedAt: null,
      selection: "explicit",
    })
  })
})
