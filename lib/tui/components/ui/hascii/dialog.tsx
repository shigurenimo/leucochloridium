import type { ReactNode } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

type Variant = "default" | "outline"

export type Props = {
  variant?: Variant
  width?: number
  children?: ReactNode
}

/** Floating dialog container. variant="default" uses a filled background; "outline" uses a bordered transparent surface. */
export function HasciiDialog(props: Props) {
  const variant = props.variant ?? "default"
  const theme = useHasciiTheme()

  if (variant === "outline") {
    return (
      <box
        flexDirection="column"
        width={props.width ?? 48}
        border
        borderStyle="rounded"
        borderColor={theme.color.border}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        gap={1}
      >
        {props.children}
      </box>
    )
  }

  return (
    <box
      flexDirection="column"
      width={props.width ?? 48}
      backgroundColor={theme.color.muted}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
    >
      {props.children}
    </box>
  )
}
