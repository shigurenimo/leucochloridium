import type { ReactNode } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type Props = {
  width?: number
  children?: ReactNode
}

/** Fixed-width vertical sidebar. Compose with HasciiSidebarHeader, HasciiSidebarContent, HasciiSidebarMenuItem. */
export function HasciiSidebar(props: Props) {
  const theme = useHasciiTheme()

  return (
    <box
      flexDirection="column"
      width={props.width ?? 24}
      backgroundColor={theme.color.muted}
      paddingTop={1}
      gap={0}
    >
      {props.children}
    </box>
  )
}
