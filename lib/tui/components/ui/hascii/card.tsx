import type { ReactNode } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type Props = {
  width?: number
  children?: ReactNode
}

/** Filled container that frames its children. Use with HasciiCardHeader, HasciiCardContent, and HasciiCardFooter. */
export function HasciiCard(props: Props) {
  const theme = useHasciiTheme()

  return (
    <box
      backgroundColor={theme.color.card}
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      gap={0}
      width={props.width}
    >
      {props.children}
    </box>
  )
}
