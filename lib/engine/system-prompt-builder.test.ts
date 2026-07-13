import { describe, expect, it } from "vitest"
import { LeucoSystemPromptBuilder } from "@/engine/system-prompt-builder"

const baseProps = {
  projectName: "demo",
  projectPath: "/tmp/demo",
  identities: [],
  presets: [] as string[],
  perAgentInstructions: null,
}

describe("LeucoSystemPromptBuilder", () => {
  it("renders the static skeleton with project header", () => {
    const out = new LeucoSystemPromptBuilder(baseProps).build()

    expect(out).toContain("# leuco built-in instructions")
    expect(out).toContain("Project: `demo`")
    expect(out).toContain("/tmp/demo")
  })

  it("notes when no Slack channels are connected", () => {
    const out = new LeucoSystemPromptBuilder(baseProps).build()
    expect(out).toContain("No Slack channels are connected")
  })

  it("includes each channel's bot user id when known", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      identities: [
        { name: "general", type: "slack", botUserId: "U01ABC" },
        { name: "ops", type: "slack", botUserId: null },
      ],
    }).build()

    expect(out).toContain("channel-config `general`")
    expect(out).toContain("`U01ABC`")
    expect(out).toContain("<@U01ABC>")
    expect(out).toContain("channel-config `ops`")
    expect(out).toContain("not yet known")
  })

  it("warns about bot loops and silent replies", () => {
    const out = new LeucoSystemPromptBuilder(baseProps).build()
    expect(out).toContain("Avoid bot loops")
    expect(out).toContain("never reply to messages whose `user` matches your own bot user id")
    expect(out).toContain("return an empty string")
  })

  it("explains that turn output is monologue and slack writes go via MCP", () => {
    const out = new LeucoSystemPromptBuilder(baseProps).build()
    expect(out).toContain("## How to reply")
    expect(out).toContain("leuco does NOT post your turn text to Slack")
    expect(out).toContain("`slack_call` MCP tool")
    expect(out).toContain("`chat.postMessage`")
    expect(out).toContain("`thread_ts`")
  })

  it("asks agents to keep local command output bounded", () => {
    const out = new LeucoSystemPromptBuilder(baseProps).build()
    expect(out).toContain("## Local command hygiene")
    expect(out).toContain("Keep shell output bounded")
    expect(out).toContain("`rg -m`")
  })

  it("appends per-agent instructions after a separator", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      perAgentInstructions: "you are a friendly bot",
    }).build()

    expect(out).toContain("\n\n---\n\nyou are a friendly bot")
  })

  it("omits the separator block when there are no per-agent instructions", () => {
    const out = new LeucoSystemPromptBuilder(baseProps).build()
    expect(out).not.toContain("\n---\n")
  })

  it("treats whitespace-only per-agent instructions as empty", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      perAgentInstructions: "   \n\n  ",
    }).build()
    expect(out).not.toContain("\n---\n")
  })

  it("splices each preset between the preamble and the per-agent tail", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      presets: ["# Friendly persona\nbe warm", "# Concise\nbe brief"],
      perAgentInstructions: "you are mochi",
    }).build()

    const beforePresetA = out.indexOf("# leuco built-in instructions")
    const presetA = out.indexOf("# Friendly persona")
    const presetB = out.indexOf("# Concise")
    const tail = out.indexOf("you are mochi")

    expect(beforePresetA).toBeLessThan(presetA)
    expect(presetA).toBeLessThan(presetB)
    expect(presetB).toBeLessThan(tail)
    expect(out.split("\n---\n").length).toBe(4)
  })

  it("ignores empty / whitespace-only presets", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      presets: ["", "   \n  ", "real preset"],
    }).build()

    expect(out).toContain("real preset")
    expect(out.split("\n---\n").length).toBe(2)
  })

  it("notes that no schedule channel is registered when none exists", () => {
    const out = new LeucoSystemPromptBuilder(baseProps).build()
    expect(out).toContain("## Scheduled prompts")
    expect(out).toContain("No schedule channel is registered")
  })

  it("lists schedule channels and the schedule_* MCP tools when present", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      identities: [
        { name: "general", type: "slack", botUserId: "U01ABC" },
        { name: "cron", type: "schedule", botUserId: null },
      ],
    }).build()

    expect(out).toContain("## Scheduled prompts")
    expect(out).toContain("`cron`")
    expect(out).toContain("`schedule_create`")
    expect(out).toContain("`schedule_list`")
    expect(out).toContain("`schedule_delete`")
    expect(out).toContain("<schedule channel=")
    // schedule channels do not appear under the Slack identity heading
    const slackIdx = out.indexOf("## Slack identity")
    const scheduleIdx = out.indexOf("## Scheduled prompts")
    const cronInSlackBlock = out.slice(slackIdx, scheduleIdx).includes("`cron`")
    expect(cronInSlackBlock).toBe(false)
  })

  it("omits the dynamic preamble when usePreamble is false", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      usePreamble: false,
      presets: ["just the preset"],
      perAgentInstructions: "and the tail",
    }).build()

    expect(out).not.toContain("# leuco built-in instructions")
    expect(out).toBe("just the preset\n\n---\n\nand the tail")
  })
})
