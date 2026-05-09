import type { ReactNode } from "react"
import { useHasciiToggleGroup } from "@/tui/components/ui/hascii/toggle-group"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"
import { usePressable } from "@/tui/components/hooks/hascii/use-pressable"

export type Props = {
  value: string
  children?: ReactNode
}

/** Pressable cell inside HasciiToggleGroup. Pressed state is controlled by the surrounding group. */
export function HasciiToggleGroupItem(props: Props) {
  const theme = useHasciiTheme()
  const ctx = useHasciiToggleGroup()

  const isSelected = ctx?.isPressed(props.value) ?? false

  const press = usePressable({
    onPress: () => ctx?.toggle(props.value),
  })

  const bg = isSelected
    ? press.isPressed
      ? theme.color.primaryActive
      : press.isHovered
        ? theme.color.primaryHover
        : theme.color.primary
    : press.isPressed
      ? theme.color.secondaryActive
      : press.isHovered
        ? theme.color.secondaryHover
        : theme.color.popover

  const fg = isSelected
    ? theme.color.primaryForeground
    : press.isHovered
      ? theme.color.foreground
      : theme.color.mutedForeground

  return (
    <box height={1} paddingLeft={2} paddingRight={2} backgroundColor={bg} {...press.bind}>
      <text fg={fg}>{props.children}</text>
    </box>
  )
}
