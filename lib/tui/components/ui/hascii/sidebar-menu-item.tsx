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
  if (isHovered && isActive) return theme.color.hoverActive
  if (isHovered) return theme.color.secondaryHover
  if (isActive) return theme.color.secondaryActive
  return undefined
}

const ROW_HEIGHT = 3

/** Single pressable row inside HasciiSidebarContent. Active items show a thin left rule using ▏ glyphs. */
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
      {isActive ? (
        <box position="absolute" left={0} top={0} bottom={0} flexDirection="column">
          {Array.from({ length: ROW_HEIGHT }, (_, index) => (
            <text key={index} fg={theme.color.primary}>
              ▏
            </text>
          ))}
        </box>
      ) : null}
      <text fg={fg}>{props.children}</text>
    </box>
  )
}
