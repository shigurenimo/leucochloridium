import type { ReactNode } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type Props = {
  children?: ReactNode
}

/** Secondary descriptive text rendered under a HasciiDialogTitle. */
export function HasciiDialogDescription(props: Props) {
  const theme = useHasciiTheme()

  return <text fg={theme.color.mutedForeground}>{props.children}</text>
}
