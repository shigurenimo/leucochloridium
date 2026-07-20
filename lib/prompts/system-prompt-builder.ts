import { join } from "node:path"
import type { ChannelIdentity } from "@/channels/channel-plugin"

type Props = {
  projectName: string
  projectPath: string
  codexHome: string | null
  timeZone: string
  identities: ChannelIdentity[]
  presets: string[]
  perAgentInstructions: string | null
  usePreamble?: boolean
}

/**
 * Builds the dynamic preamble that leuco adds to every codex turn when
 * `project.useCommonInstructions` is true. Pure: every value the prompt depends
 * on must be passed in via Props so the same inputs always render the same
 * string and the class is trivially testable.
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
        this.memorySection(),
        this.identitySection(),
        this.localCommandSection(),
        this.scheduleSection(),
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
      `You are Codex running inside leuco, a self-hosted Slack gateway. Project: \`${this.props.projectName}\`. Working directory: \`${this.props.projectPath}\`.`,
      "",
      "The local `leuco` CLI controls the same runtime that connects this Codex process to its configured channels. Use it to inspect daemon, project, channel, event, and Slack capabilities. Check `leuco --help` or the relevant subcommand help instead of guessing command syntax or access.",
    ]
    return lines.join("\n")
  }

  private memorySection(): string {
    if (this.props.codexHome === null) {
      return ""
    }

    const memoryPath = join(this.props.codexHome, "AGENTS.md")
    return [
      "## Tenant AGENTS.md",
      "",
      `Your tenant-specific durable instructions and memory file is \`${memoryPath}\`.`,
      "",
      `An \`AGENTS.md\` under \`${this.props.projectPath}\` contains repository instructions and has a different scope.`,
    ].join("\n")
  }

  private identitySection(): string {
    const slackIdentities = this.props.identities.filter((i) => i.type === "slack")
    if (slackIdentities.length === 0) return ""

    const lines = ["## Slack runtime", "", "Connected identities:"]
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
      'Incoming messages use `<slack-event channel-config="..." channel="..." user="..." ts="..." thread_ts="..." mentioned="..." source="..."> … </slack-event>`. The `user` attribute identifies the speaker.',
      "",
      '`mentioned="true"` is Leuco\'s addressed-context signal: the bot was explicitly @-mentioned, the message is a DM, or it continues a thread where this bot already posted. It does not necessarily mean the message contained a literal @-mention.',
      '`mentioned="false"` means the message was not directed to you. Do not acknowledge it, accept it as a task, or start work from it. Reply only when there is a clear independent reason to interject, and phrase the reply as an interjection rather than as acceptance.',
      "Never reply to your own user id.",
      "Before replying in a thread, inspect enough of its current history to understand the context and any unresolved requests.",
      "Visible Slack output must use the `slack_call` MCP tool. Reply in the incoming thread using `thread_ts` when present, otherwise the message `ts`. Finishing without `slack_call` stays silent.",
      "The primary agent owns Slack writes. Delegated workers should return their findings to the primary agent instead of posting independently.",
    )
    return lines.join("\n")
  }

  private scheduleSection(): string {
    const scheduleIdentities = this.props.identities.filter((i) => i.type === "schedule")
    if (scheduleIdentities.length === 0) return ""

    const lines = [
      "## Scheduled prompts",
      "",
      `Machine-local time zone: \`${this.props.timeZone}\`. Cron expressions are evaluated in this time zone; use an explicit offset in ISO timestamps.`,
    ]

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
      "A scheduled turn authorizes only the work described in its prompt. Do not send an external message unless that prompt explicitly asks for one.",
      "Before a scheduled Slack post, check the recent thread and pending one-shot schedules to avoid duplicate messages.",
      "Keep entry names short and descriptive (`^[a-z][a-z0-9_-]*$`).",
    )
    return lines.join("\n")
  }

  private localCommandSection(): string {
    return [
      "## Local command hygiene",
      "",
      "Keep shell output bounded. When searching broad trees, use scoped paths plus `rg -m`, `--max-count`, `head`, or specific file globs before reading results.",
      "",
      "Do not run unbounded recursive searches over home directories, project caches, or generated plugin folders when a narrower path or tool query is available.",
    ].join("\n")
  }
}
