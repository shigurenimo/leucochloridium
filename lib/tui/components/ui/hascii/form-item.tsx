import type { ReactNode } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

type Direction = "column" | "row"

export type Props = {
  label: string
  direction?: Direction
  width?: number
  labelWidth?: number
  children?: ReactNode
}

/** Labelled wrapper around a form field. direction="row" lays the label beside the field. */
export function HasciiFormItem(props: Props) {
  const direction = props.direction ?? "column"
  const theme = useHasciiTheme()

  if (direction === "row") {
    const labelWidth = props.labelWidth ?? 12

    return (
      <box flexDirection="row" width={props.width} gap={1} alignItems="center">
        <box width={labelWidth}>
          <text fg={theme.color.mutedForeground}>{props.label}</text>
        </box>
        <box flexGrow={1}>{props.children}</box>
      </box>
    )
  }

  return (
    <box flexDirection="column" width={props.width} gap={0}>
      <text fg={theme.color.mutedForeground}>{props.label}</text>
      {props.children}
    </box>
  )
}
