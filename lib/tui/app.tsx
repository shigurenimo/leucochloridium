/** @jsxImportSource @opentui/react */
import { useKeyboard, useRenderer } from "@opentui/react"
import type { LeucoEvent } from "@/events/leuco-event-types"
import { useEvents } from "@/tui/use-events"

type Props = {
  eventLogPath: string
}

/**
 * 最小構成のリアルタイムイベントビューア。最新が先頭、scrollbox で全件閲覧可能。
 * ESC / q / Ctrl-C で終了。
 */
export function App(props: Props) {
  const renderer = useRenderer()
  const events = useEvents({ path: props.eventLogPath, capacity: 500 })

  useKeyboard((key) => {
    if (key.name === "escape") {
      renderer.destroy()
      return
    }
    if (key.name === "q") {
      renderer.destroy()
      return
    }
    if (key.ctrl === true && key.name === "c") {
      renderer.destroy()
    }
  })

  const reversed = events.slice().reverse()

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <scrollbox
        style={{
          flexGrow: 1,
          paddingLeft: 1,
          paddingRight: 1,
        }}
        focused
      >
        {reversed.map((event, i) => (
          <box key={`${event.ts}-${i}`} style={{ flexDirection: "row" }}>
            <text fg="#6b7280">{formatTime(event.ts) + " "}</text>
            <text fg={colorFor(event)}>{event.type.padEnd(20)}</text>
            <text fg="#9ca3af">{formatScope(event)}</text>
            <text fg="#e5e7eb">{formatSummary(event)}</text>
          </box>
        ))}
      </scrollbox>
    </box>
  )
}

const formatScope = (event: LeucoEvent): string => {
  if (event.type === "engine.reconcile" || event.type === "log") return ""
  if ("project" in event && "agent" in event) {
    return `${event.project}/${event.agent} `
  }
  return ""
}

const formatTime = (ms: number): string => {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

const colorFor = (event: LeucoEvent): string => {
  switch (event.type) {
    case "log":
      return event.level === "error" ? "#f87171" : event.level === "warn" ? "#fbbf24" : "#6b7280"
    case "tenant.started":
      return "#34d399"
    case "tenant.stopped":
      return "#f97316"
    case "engine.reconcile":
      return "#a78bfa"
    case "slack.event":
      return "#60a5fa"
    case "turn.start":
      return "#fbbf24"
    case "turn.complete":
      return "#34d399"
    case "turn.error":
      return "#f87171"
    case "codex.notification":
      return "#9ca3af"
    default:
      return "#e5e7eb"
  }
}

const formatSummary = (event: LeucoEvent): string => {
  switch (event.type) {
    case "log":
      return event.line
    case "tenant.started":
      return "started"
    case "tenant.stopped":
      return "stopped"
    case "engine.reconcile":
      return `+${event.added.length} -${event.removed.length}`
    case "slack.event":
      if (event.event.kind === "message") {
        const m = event.event
        return `${m.source} channel=${m.channel} ${m.mentioned ? "[mentioned] " : ""}${truncate(m.text, 80)}`
      }
      return `${event.event.kind} :${event.event.emoji}: by=${event.event.user}`
    case "turn.start":
      return `→ ${truncate(event.input, 80)}`
    case "turn.complete":
      return `✓ ${truncate(event.reply, 80)}`
    case "turn.error":
      return `✗ ${event.error}`
    case "codex.notification":
      return event.method
    default:
      return ""
  }
}

const truncate = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}
