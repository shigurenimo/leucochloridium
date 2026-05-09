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
    <box flexDirection="row" gap={0} height={2}>
      {props.items.map((item) => {
        const isActive = item.value === current
        const fg = isActive ? theme.color.foreground : theme.color.mutedForeground
        const itemWidth = item.label.length + 4

        return (
          <box
            key={item.value}
            height={2}
            paddingLeft={2}
            paddingRight={2}
            onMouseUp={() => onSelect(item.value)}
          >
            <text fg={fg}>{item.label}</text>
            {isActive ? (
              <box position="absolute" bottom={0} left={0} right={0}>
                <text fg={theme.color.primary}>{"▁".repeat(itemWidth)}</text>
              </box>
            ) : null}
          </box>
        )
      })}
    </box>
  )
}
