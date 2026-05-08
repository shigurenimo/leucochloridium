import { join } from "node:path"
import type { ChannelIdentity } from "@/engine/channel-plugin"

export type SubagentEntry = {
  name: string
  path: string
}

type Props = {
  projectName: string
  projectPath: string
  agentName: string
  identities: ChannelIdentity[]
  subagents: SubagentEntry[]
  /**
   * Pre-resolved preset bodies (already looked up from
   * `LeucoPromptPresets`). Each entry is spliced in between the dynamic
   * preamble and the per-agent TOML text, separated by `---` blocks.
   */
  presets: string[]
  perAgentInstructions: string | null
  /**
   * When false, the dynamic preamble (project / agent header, Slack
   * identities, response policy, sub-agent paths) is omitted and only the
   * presets + per-agent text are emitted. Defaults to true at the call site.
   */
  usePreamble?: boolean
}

/**
 * Builds the dynamic preamble that leuco prepends to every codex turn when
 * `agent.useCommonInstructions` is true. Pure: every value the prompt depends
 * on must be passed in via Props so the same inputs always render the same
 * string and the class is trivially testable.
 *
 * Sections:
 *   1. project / agent header (so codex knows where it is running)
 *   2. Slack identity per channel — the bot's own user id, used by codex to
 *      filter out its own messages and avoid bot loops
 *   3. response policy — discourage replying to every event
 *   4. how to reply — turn output is monologue, Slack writes go through MCP
 *   5. loop avoidance — never reply to your own bot user id, etc.
 *   6. sub-agent paths — the agent is encouraged to edit these TOML files
 */
export class LeucoSystemPromptBuilder {
  constructor(private readonly props: Props) {
    Object.freeze(this)
  }

  build(): string {
    const blocks: string[] = []

    if (this.props.usePreamble !== false) {
      const sections = [
        this.headerSection(),
        this.identitySection(),
        this.responseSection(),
        this.replySection(),
        this.scheduleSection(),
        this.loopSection(),
        this.subagentSection(),
      ]
      blocks.push(sections.filter((s) => s.length > 0).join("\n\n"))
    }

    for (const preset of this.props.presets) {
      const trimmed = preset.trim()
      if (trimmed.length > 0) blocks.push(trimmed)
    }

    const tail = this.props.perAgentInstructions?.trim() ?? ""
    if (tail.length > 0) blocks.push(tail)

    return blocks.join("\n\n---\n\n")
  }

  private headerSection(): string {
    const lines = [
      "# leuco built-in instructions",
      "",
      `You are running inside leuco, a self-hosted Slack gateway. Project: \`${this.props.projectName}\`. Agent: \`${this.props.agentName}\`. Working directory: \`${this.props.projectPath}\`.`,
    ]
    return lines.join("\n")
  }

  private identitySection(): string {
    const slackIdentities = this.props.identities.filter((i) => i.type === "slack")
    const lines = ["## Slack identity"]
    if (slackIdentities.length === 0) {
      lines.push("", "No Slack channels are connected for this agent yet.")
      return lines.join("\n")
    }

    lines.push("", `You are connected to ${slackIdentities.length} Slack channel(s):`)
    for (const identity of slackIdentities) {
      const id = identity.botUserId
      const tail =
        id === null
          ? "(bot user id not yet known — fetched on connect)"
          : `your bot user id is \`${id}\` — mention yourself as \`<@${id}>\``
      lines.push(`- channel-config \`${identity.name}\`: ${tail}`)
    }

    lines.push(
      "",
      'Each Slack message arrives as `<slack-event channel-config="..." channel="..." user="..." ts="..." thread_ts="..." mentioned="..." source="..."> … </slack-event>`. The `user` attribute is the Slack user id of the speaker — always compare it to your own bot user id before acting.',
    )
    return lines.join("\n")
  }

  private scheduleSection(): string {
    const scheduleIdentities = this.props.identities.filter((i) => i.type === "schedule")
    const lines = ["## Scheduled prompts"]

    if (scheduleIdentities.length === 0) {
      lines.push(
        "",
        "No schedule channel is registered for this agent. Ask the operator to run `leuco projects <p> agents <a> channels add schedule` if you want to set timed reminders.",
      )
      return lines.join("\n")
    }

    lines.push("", "You own the following schedule channels:")
    for (const identity of scheduleIdentities) {
      lines.push(`- \`${identity.name}\``)
    }

    lines.push(
      "",
      'When an entry fires, you receive a turn whose input is wrapped as `<schedule channel="..." entry="..." run-at="..."> … </schedule>` — treat the inner text as a fresh task you scheduled for yourself.',
      "",
      "You may add, list, and remove entries on yourself via these MCP tools:",
      "- `schedule_create` — register a new entry. `run_at` is either an ISO 8601 timestamp (one-shot, deleted after fire) or a 5-field cron expression (recurring).",
      "- `schedule_list` — read all entries you own.",
      "- `schedule_delete` — remove one entry by id or name.",
      "",
      "Use these for reminders, recurring checks, or deferring a task until later. Keep entry names short and descriptive (`^[a-z][a-z0-9_-]*$`).",
    )
    return lines.join("\n")
  }

  private responseSection(): string {
    return [
      "## When to respond",
      "",
      'You do not need to reply to every message. Reply only when the user clearly addresses you (`mentioned="true"`), when a thread you are already participating in continues, or when you have a clear reason to interject. Otherwise return an empty string — the gateway will stay silent.',
    ].join("\n")
  }

  private replySection(): string {
    return [
      "## How to reply",
      "",
      "Your turn output is internal monologue. **leuco does NOT post your turn text to Slack.** It is logged for the operator and discarded.",
      "",
      "To send anything visible in Slack you MUST call the `slack_call` MCP tool with a Web API method such as `chat.postMessage`. Always pass `thread_ts` from the incoming `<slack-event>` envelope so the reply lands in the same thread.",
      "",
      "If you decide not to post — because the message wasn't for you, or another bot is handling it, or there's nothing to add — simply finish the turn without calling the tool. Returning text without calling the tool is the same as silence, and silence is often the correct answer.",
    ].join("\n")
  }

  private loopSection(): string {
    return [
      "## Avoid bot loops",
      "",
      "Other bots may share this workspace. To prevent infinite back-and-forth:",
      "- never reply to messages whose `user` matches your own bot user id",
      "- be conservative when replying to other bots — only continue the exchange if a human in the thread clearly wants it",
      "- if a thread has only bots talking, stop replying",
    ].join("\n")
  }

  private subagentSection(): string {
    const dir = join(this.props.projectPath, ".codex", "agents")
    const selfPath = join(dir, `${this.props.agentName}.toml`)
    const lines = [
      "## Sub-agents",
      "",
      `Your own definition file is \`${selfPath}\` — read it when you need to recall your own configured behavior, and edit it when you decide to change how you operate.`,
      "",
      `Other sub-agent definitions in this project live under \`${dir}/<name>.toml\`.`,
    ]

    if (this.props.subagents.length === 0) {
      lines.push("", "No other sub-agents are registered yet.")
    } else {
      lines.push("", "Currently registered:")
      for (const sub of this.props.subagents) {
        lines.push(`- \`${sub.name}\` — \`${sub.path}\``)
      }
    }

    lines.push(
      "",
      "You may edit any of these TOML files freely to refine `developer_instructions`. Treat improving these prompts — your own and your sub-agents' — as part of your normal work; when you learn something that should change behavior, persist it back into the file.",
    )
    return lines.join("\n")
  }
}
