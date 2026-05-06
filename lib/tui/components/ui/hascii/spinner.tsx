import { useEffect, useState } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export const SPINNER_KINDS = {
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  dots: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
  line: ["|", "/", "-", "\\"],
  noise: ["▓", "▒", "░", "▒"],
  pipe: ["┤", "┘", "┴", "└", "├", "┌", "┬", "┐"],
  block: ["▌", "▀", "▐", "▄"],
  growVert: ["▁", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃"],
  toggle: ["▢", "▣", "▤", "▥", "▦", "▧", "▨", "▩"],
} as const satisfies Record<string, readonly string[]>

export type SpinnerKind = keyof typeof SPINNER_KINDS

export type Props = {
  variant?: SpinnerKind
  intervalMs?: number
  color?: string
}

/** Animated single-cell spinner. variant chooses the glyph cycle, intervalMs the cadence. */
export function HasciiSpinner(props: Props) {
  const variant: SpinnerKind = props.variant ?? "braille"
  const intervalMs = props.intervalMs ?? 80

  const theme = useHasciiTheme()
  const color = props.color ?? theme.color.foreground

  const frames = SPINNER_KINDS[variant]

  const frameState = useState(0)
  const frame = frameState[0]
  const setFrame = frameState[1]

  // useEffect is necessary for time-based frame advancement in a TUI loop.
  useEffect(() => {
    const id = setInterval(() => {
      setFrame((current) => (current + 1) % frames.length)
    }, intervalMs)

    return () => clearInterval(id)
  }, [frames, intervalMs, setFrame])

  return <text fg={color}>{frames[frame]}</text>
}
