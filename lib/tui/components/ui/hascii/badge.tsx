import type { ReactNode } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

type Variant = "default" | "secondary" | "outline" | "destructive"

export type Props = {
  variant?: Variant
  children?: ReactNode
}

/** Compact status indicator with default, secondary, outline, and destructive variants. */
export function HasciiBadge(props: Props) {
  const variant = props.variant ?? "default"
  const theme = useHasciiTheme()

  if (variant === "secondary") {
    return (
      <box paddingLeft={1} paddingRight={1} backgroundColor={theme.color.secondary}>
        <text fg={theme.color.secondaryForeground}>{props.children}</text>
      </box>
    )
  }

  if (variant === "outline") {
    return (
      <box
        paddingLeft={1}
        paddingRight={1}
        border
        borderStyle="rounded"
        borderColor={theme.color.border}
      >
        <text fg={theme.color.foreground}>{props.children}</text>
      </box>
    )
  }

  if (variant === "destructive") {
    return (
      <box paddingLeft={1} paddingRight={1} backgroundColor={theme.color.destructive}>
        <text fg={theme.color.destructiveForeground}>{props.children}</text>
      </box>
    )
  }

  return (
    <box paddingLeft={1} paddingRight={1} backgroundColor={theme.color.primary}>
      <text fg={theme.color.primaryForeground}>{props.children}</text>
    </box>
  )
}
