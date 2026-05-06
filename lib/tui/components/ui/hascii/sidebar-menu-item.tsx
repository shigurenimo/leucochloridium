import type { ReactNode } from "react"
import type { HasciiTheme } from "@/tui/utils/hascii/theme"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"
import { usePressable } from "@/tui/components/hooks/hascii/use-pressable"

export type Props = {
  isActive?: boolean
  isDisabled?: boolean
  onPress?: () => void
  children?: ReactNode
}

const pickBg = (
  isDisabled: boolean,
  isActive: boolean,
  isHovered: boolean,
  isPressed: boolean,
  theme: HasciiTheme,
): string | undefined => {
  if (isDisabled) return undefined
  if (isPressed) return theme.color.secondaryActive
  if (isHovered) {
    return isActive ? theme.color.secondaryActive : theme.color.secondaryHover
  }
  if (isActive) return theme.color.secondaryHover
  return undefined
}

/** Single pressable row inside HasciiSidebarContent. Background mirrors the button rest/hover/active progression. */
export function HasciiSidebarMenuItem(props: Props) {
  const isActive = props.isActive ?? false
  const isDisabled = props.isDisabled ?? false
  const theme = useHasciiTheme()

  const press = usePressable({ isDisabled, onPress: props.onPress })

  const bg = pickBg(isDisabled, isActive, press.isHovered, press.isPressed, theme)

  const fg = isDisabled
    ? theme.color.mutedForeground
    : isActive || press.isHovered
      ? theme.color.foreground
      : theme.color.mutedForeground

  return (
    <box
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={bg}
      {...press.bind}
    >
      <text fg={fg}>{props.children}</text>
    </box>
  )
}
