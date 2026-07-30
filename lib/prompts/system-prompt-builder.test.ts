import { describe, expect, it } from "vitest"
import { LeucoSystemPromptBuilder } from "@/prompts/system-prompt-builder"

const baseProps = {
  projectName: "demo",
  projectPath: "/tmp/demo",
  codexHome: "/tmp/leuco/demo/.codex",
  timeZone: "Asia/Tokyo",
  identities: [],
  presets: [] as string[],
  perAgentInstructions: null,
}

describe("LeucoSystemPromptBuilder", () => {
  it("renders the static skeleton with project header", () => {
    const out = new LeucoSystemPromptBuilder(baseProps).build()

    expect(out).toContain("# leuco built-in instructions")
    expect(out).toContain("You are Codex running inside leuco")
    expect(out).toContain("Project: `demo`")
    expect(out).toContain("/tmp/demo")
    expect(out).toContain("The local `leuco` CLI controls the same runtime")
    expect(out).toContain("`leuco --help`")
    expect(out).toContain("locked to project `demo` by `LEUCO_PROJECT_ID`")
    expect(out).toContain("Never unset or override it")
    expect(out).toContain("Leuco operations are CLI-only")
    expect(out).toContain("Do not look for or call a built-in Leuco MCP server")
  })

  it("omits Slack instructions when no Slack connector is connected", () => {
    const out = new LeucoSystemPromptBuilder(baseProps).build()
    expect(out).not.toContain("## Slack runtime")
    expect(out).not.toContain("slack_call")
  })

  it("gives the exact project instruction path and keeps it narrowly scoped", () => {
    const out = new LeucoSystemPromptBuilder(baseProps).build()

    expect(out).toContain("## Project AGENTS.md")
    expect(out).toContain("`/tmp/leuco/demo/.codex/AGENTS.md`")
    expect(out).toContain("project-specific durable instructions and memory file")
    expect(out).toContain("repository instructions")
    expect(out).not.toContain("preserve unrelated user-authored memory")
    expect(out).not.toContain("update your own rules or memory")
  })

  it("omits project instruction guidance when CODEX_HOME is unavailable", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      codexHome: null,
    }).build()

    expect(out).not.toContain("Project AGENTS.md")
    expect(out).not.toContain("AGENTS.md")
  })

  it("includes each connector's bot user id when known", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      identities: [
        { name: "general", type: "slack", botUserId: "U01ABC" },
        { name: "ops", type: "slack", botUserId: null },
      ],
    }).build()

    expect(out).toContain("connector-config `general`")
    expect(out).toContain("`U01ABC`")
    expect(out).toContain("<@U01ABC>")
    expect(out).toContain("connector-config `ops`")
    expect(out).toContain("not yet known")
  })

  it("keeps Slack routing and delivery mechanics together", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      identities: [{ name: "general", type: "slack", botUserId: "U01ABC" }],
    }).build()

    expect(out).toContain("## Slack runtime")
    expect(out).toContain("Never reply to your own user id")
    expect(out).toContain("inspect enough of its current history")
    expect(out).toContain("`leuco slack call <method>")
    expect(out).toContain("Do not pass `--project`")
    expect(out).toContain("`leuco connectors <connector-config> download-file")
    expect(out).toContain("`thread_ts`")
    expect(out).toContain("final answer is internal Codex transport output")
    expect(out).toContain("never posted to Slack by Leuco")
    expect(out).toContain("Every Slack write requires an explicit Leuco Slack command")
    expect(out).toContain("`leuco slack upload-file")
    expect(out).toContain("When silence is intentional, do not run a Slack write command")
    expect(out).toContain("The primary agent owns Slack writes")
  })

  it("defines addressed-context semantics before acknowledgements or work", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      identities: [{ name: "general", type: "slack", botUserId: "U01ABC" }],
    }).build()

    expect(out).toContain('`mentioned="true"`')
    expect(out).toContain("addressed-context signal")
    expect(out).toContain("does not necessarily mean")
    expect(out).toContain('`mentioned="false"`')
    expect(out).toContain("Do not acknowledge it")
    expect(out).toContain("start work from it")
    expect(out).toContain("clear independent reason to interject")
  })

  it("asks agents to keep local command output bounded", () => {
    const out = new LeucoSystemPromptBuilder(baseProps).build()
    expect(out).toContain("## Local command hygiene")
    expect(out).toContain("Keep shell output bounded")
    expect(out).toContain("`rg -m`")
    expect(out).toContain("Do not run machine-wide Leuco administration commands")
  })

  it("requires the scoped CLI for every Slack write", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      identities: [{ name: "general", type: "slack", botUserId: "U01ABC" }],
    }).build()

    expect(out).toContain("## Slack runtime")
    expect(out).toContain("`leuco slack call <method>")
    expect(out).not.toContain("slack_call")
    expect(out).toContain("`thread_ts`")
    expect(out).toContain("final answer is internal Codex transport output")
    expect(out).toContain("never posted to Slack by Leuco")
    expect(out).toContain("Every Slack write requires an explicit Leuco Slack command")
    expect(out).toContain("`leuco slack upload-file")
    expect(out).toContain("--connector <connector-config>")
    expect(out).toContain("Slack CLI output is bounded")
    expect(out).toContain("small `limit`")
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

  it("omits schedule instructions when no schedule connector is registered", () => {
    const out = new LeucoSystemPromptBuilder(baseProps).build()
    expect(out).not.toContain("## Scheduled prompts")
    expect(out).not.toContain("schedule_create")
  })

  it("lists schedule connectors and their scoped CLI commands when present", () => {
    const out = new LeucoSystemPromptBuilder({
      ...baseProps,
      identities: [
        { name: "general", type: "slack", botUserId: "U01ABC" },
        { name: "cron", type: "schedule", botUserId: null },
      ],
    }).build()

    expect(out).toContain("## Scheduled prompts")
    expect(out).toContain("`cron`")
    expect(out).toContain("`leuco connectors <connector-config> schedules add")
    expect(out).toContain("`leuco connectors <connector-config> schedules list`")
    expect(out).toContain("`leuco connectors <connector-config> schedules remove")
    expect(out).not.toContain("schedule_create")
    expect(out).toContain("<schedule connector=")
    expect(out).toContain("Do not send an external message")
    expect(out).toContain("avoid duplicate messages")
    // schedule connectors do not appear under the Slack identity heading
    const slackIdx = out.indexOf("## Slack runtime")
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
