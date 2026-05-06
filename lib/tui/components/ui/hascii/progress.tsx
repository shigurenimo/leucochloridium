import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type Props = {
  value?: number
  width?: number
  fillColor?: string
  trackColor?: string
}

/** Horizontal progress bar. Value is 0–1; clamped on render. */
export function HasciiProgress(props: Props) {
  const value = Math.max(0, Math.min(1, props.value ?? 0))
  const width = props.width ?? 32

  const theme = useHasciiTheme()
  const fillColor = props.fillColor ?? theme.color.primary
  const trackColor = props.trackColor ?? theme.color.muted

  const filled = Math.round(value * width)
  const empty = width - filled

  return (
    <box flexDirection="row" width={width} height={1}>
      {filled > 0 ? <box width={filled} height={1} backgroundColor={fillColor} /> : null}
      {empty > 0 ? <box width={empty} height={1} backgroundColor={trackColor} /> : null}
    </box>
  )
}
