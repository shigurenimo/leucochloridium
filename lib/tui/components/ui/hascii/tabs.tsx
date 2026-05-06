import { useState } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type TabItem = {
  value: string
  label: string
}

export type Props = {
  items: TabItem[]
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
}

/** Single-row segmented tabs. Uncontrolled by default; pass value + onChange to control externally. */
export function HasciiTabs(props: Props) {
  const theme = useHasciiTheme()

  const initial = props.defaultValue ?? props.value ?? props.items[0]?.value ?? ""

  const internalState = useState(initial)
  const internal = internalState[0]
  const setInternal = internalState[1]

  const current = props.value ?? internal

  const onSelect = (next: string) => {
    if (props.value === undefined) setInternal(next)
    props.onChange?.(next)
  }

  return (
    <box flexDirection="row" gap={0} height={1}>
      {props.items.map((item) => {
        const isActive = item.value === current
        const bg = isActive ? theme.color.primary : theme.color.muted
        const fg = isActive ? theme.color.primaryForeground : theme.color.mutedForeground

        return (
          <box
            key={item.value}
            height={1}
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={bg}
            onMouseUp={() => onSelect(item.value)}
          >
            <text fg={fg}>{item.label}</text>
          </box>
        )
      })}
    </box>
  )
}
