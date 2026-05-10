import { useId } from "react"
import type { ReactNode } from "react"
import { HasciiFormItemProvider } from "@/tui/utils/hascii/form-item-context"
import { useHasciiInputFocus } from "@/tui/utils/hascii/input-focus-context"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type Props = {
  label: string
  labelWidth?: number
  children: ReactNode
}

/** Horizontal form row: a fixed-width label on the left, the field on the right. The label background brightens while the wrapped HasciiInput is focused (requires HasciiInputFocusProvider in the tree). */
export function HasciiFormItem(props: Props) {
  const labelWidth = props.labelWidth ?? 12
  const theme = useHasciiTheme()

  const id = useId()
  const inputFocus = useHasciiInputFocus()
  const isInputFocused = inputFocus?.focusedId === id

  const labelBg = isInputFocused ? theme.color.secondaryActive : theme.color.popover
  const labelFg = isInputFocused ? theme.color.foreground : theme.color.mutedForeground

  return (
    <HasciiFormItemProvider value={{ focusId: id }}>
      <box flexDirection="row" alignItems="center">
        <box
          width={labelWidth}
          height={3}
          paddingLeft={2}
          paddingRight={2}
          alignItems="flex-start"
          justifyContent="center"
          backgroundColor={labelBg}
        >
          <text fg={labelFg}>{props.label}</text>
        </box>
        {props.children}
      </box>
    </HasciiFormItemProvider>
  )
}
