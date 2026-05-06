import type { ReactNode } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"
import { usePressable } from "@/tui/components/hooks/hascii/use-pressable"

export type Props = {
  onClose?: () => void
  children?: ReactNode
}

/** Dialog header row. Children rendered on the left; an x close button is rendered top-right when onClose is provided. */
export function HasciiDialogHeader(props: Props) {
  const theme = useHasciiTheme()
  const press = usePressable({ onPress: props.onClose })

  const closeFg = press.isPressed
    ? theme.color.primaryActive
    : press.isHovered
      ? theme.color.foreground
      : theme.color.mutedForeground

  return (
    <box flexDirection="row" alignItems="flex-start" justifyContent="space-between">
      <box flexDirection="column" flexGrow={1} gap={1}>
        {props.children}
      </box>
      {props.onClose ? (
        <box paddingLeft={1} paddingRight={1} {...press.bind}>
          <text fg={closeFg}>x</text>
        </box>
      ) : null}
    </box>
  )
}
