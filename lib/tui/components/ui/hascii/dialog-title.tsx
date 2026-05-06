import type { ReactNode } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type Props = {
  children?: ReactNode
}

/** Primary title text inside a HasciiDialogHeader. */
export function HasciiDialogTitle(props: Props) {
  const theme = useHasciiTheme()

  return <text fg={theme.color.foreground}>{props.children}</text>
}
