import { join } from "node:path"
import type { ConnectorIdentity } from "@/connectors/connector"

type Props = {
  projectName: string
  projectPath: string
  codexHome: string | null
  timeZone: string
  identities: ConnectorIdentity[]
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
      "The local `leuco` CLI controls the same runtime that connects this Codex process to its configured connectors. Use it to inspect daemon, project, connector, event, and Slack capabilities. Check `leuco --help` or the relevant subcommand help instead of guessing command syntax or access.",
      "",
      `This process is locked to project \`${this.props.projectName}\` by \`LEUCO_PROJECT_ID\`. Never unset or override it. The short \`leuco connectors …\` form and project-omitted Slack commands automatically target this project even if the shell working directory changes. An explicitly different project is rejected; never try to address another project from this process.`,
      "",
      "Leuco operations are CLI-only. Do not look for or call a built-in Leuco MCP server. Any MCP tools that happen to be available are project-provided external services, not aliases for Leuco CLI operations.",
    ]
    return lines.join("\n")
  }

  private memorySection(): string {
    if (this.props.codexHome === null) {
      return ""
    }

    const memoryPath = join(this.props.codexHome, "AGENTS.md")
    return [
      "## Project AGENTS.md",
      "",
      `Your project-specific durable instructions and memory file is \`${memoryPath}\`.`,
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
      lines.push(`- connector-config \`${identity.name}\`: ${tail}`)
    }

    lines.push(
      "",
      'Incoming messages use `<slack-event connector-config="..." channel="..." user="..." ts="..." thread_ts="..." mentioned="..." source="..."> … </slack-event>`. The `user` attribute identifies the speaker.',
      "",
      '`mentioned="true"` is Leuco\'s addressed-context signal: the bot was explicitly @-mentioned, the message is a DM, or it continues a thread where this bot already posted. It does not necessarily mean the message contained a literal @-mention.',
      '`mentioned="false"` means the message was not directed to you. Do not acknowledge it, accept it as a task, or start work from it. Reply only when there is a clear independent reason to interject, and phrase the reply as an interjection rather than as acceptance.',
      "Never reply to your own user id.",
      "Before replying in a thread, inspect enough of its current history to understand the context and any unresolved requests.",
      "Your final answer is internal Codex transport output and is never posted to Slack by Leuco. Every Slack write requires an explicit `leuco slack call`; never assume final text is visible to Slack users.",
      "To reply or perform another Slack API call, run `leuco slack call <method> --connector <connector-config> --body '<json>'`. Do not pass `--project`; the injected project scope selects this project. The `--connector` value selects a stored Slack identity, while the JSON `channel` field is the Slack conversation id from the incoming event.",
      "For `chat.postMessage`, set JSON `thread_ts` to the event's `thread_ts` when present, otherwise its `ts`.",
      "To download a private Slack file, run `leuco connectors <connector-config> download-file --file <file-id> --out <path>`.",
      "When silence is intentional, do not run a Slack write command.",
      "Slack CLI output is bounded. For history, search, and list methods, start with a small `limit` and follow cursors only as needed.",
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

    lines.push("", "You own the following schedule connectors:")
    for (const identity of scheduleIdentities) {
      lines.push(`- \`${identity.name}\``)
    }

    lines.push(
      "",
      'When an entry fires, you receive a turn whose input is wrapped as `<schedule connector="..." entry="..." run-at="..."> … </schedule>` — treat the inner text as a fresh task you scheduled for yourself.',
      "",
      "Use the project-scoped CLI to manage your own entries:",
      "- Add: `leuco connectors <connector-config> schedules add --name <name> --run-at '<expression>' --prompt '<text>'`.",
      "- List: `leuco connectors <connector-config> schedules list`.",
      "- Remove: `leuco connectors <connector-config> schedules remove <id-or-name>`.",
      "`--run-at` is either an ISO 8601 timestamp (one-shot, deleted after fire) or a 5-field cron expression (recurring). Always use one of the schedule connector-config names listed above and never spell out another project.",
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
      "Do not run machine-wide Leuco administration commands (`start`, `stop`, `restart`, `boot`, or `config`) from this project runtime unless the user explicitly asks you to administer the Leuco installation.",
    ].join("\n")
  }
}
