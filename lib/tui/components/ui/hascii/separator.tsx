import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

type Orientation = "horizontal" | "vertical"

export type Props = {
  orientation?: Orientation
  color?: string
  length?: number
}

/** Hairline divider drawn with box-drawing characters. Length is the run in the chosen orientation. */
export function HasciiSeparator(props: Props) {
  const orientation = props.orientation ?? "horizontal"
  const length = props.length ?? (orientation === "horizontal" ? 32 : 8)

  const theme = useHasciiTheme()
  const color = props.color ?? theme.color.border

  if (orientation === "vertical") {
    const lines: string[] = []
    for (let index = 0; index < length; index++) lines.push("│")

    return (
      <box width={1} height={length} flexShrink={0}>
        <text fg={color}>{lines.join("\n")}</text>
      </box>
    )
  }

  return (
    <box width={length} height={1} flexShrink={0}>
      <text fg={color}>{"─".repeat(length)}</text>
    </box>
  )
}
