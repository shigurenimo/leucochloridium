import type { ReactNode } from "react"
import type { HasciiTheme } from "@/tui/utils/hascii/theme"
import { useHasciiAccordion } from "@/tui/components/ui/hascii/accordion"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"
import { usePressable } from "@/tui/components/hooks/hascii/use-pressable"

export type Props = {
  value: string
  title: string
  children?: ReactNode
}

const HEADER_HEIGHT = 3

const pickHeaderBg = (
  isOpen: boolean,
  isHovered: boolean,
  isPressed: boolean,
  theme: HasciiTheme,
): string | undefined => {
  if (isPressed) return theme.color.secondaryActive
  if (isHovered && isOpen) return theme.color.hoverActive
  if (isHovered) return theme.color.secondaryHover
  if (isOpen) return theme.color.secondaryActive
  return undefined
}

/** Single collapsible row inside HasciiAccordion. Header tracks the same hover/active palette as HasciiSidebarMenuItem; body uses a muted text color. */
export function HasciiAccordionItem(props: Props) {
  const accordion = useHasciiAccordion()
  const theme = useHasciiTheme()

  const isOpen = accordion?.isOpen(props.value) ?? false

  const press = usePressable({
    onPress: () => accordion?.toggle(props.value),
  })

  const headerBg = pickHeaderBg(isOpen, press.isHovered, press.isPressed, theme)

  const titleFg =
    isOpen || press.isHovered ? theme.color.foreground : theme.color.mutedForeground

  const indicator = isOpen ? "▾" : "▸"

  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        alignItems="center"
        gap={1}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        height={HEADER_HEIGHT}
        backgroundColor={headerBg}
        {...press.bind}
      >
        {isOpen ? (
          <box position="absolute" left={0} top={0} bottom={0} flexDirection="column">
            {Array.from({ length: HEADER_HEIGHT }, (_, index) => (
              <text key={index} fg={theme.color.primary}>
                ▏
              </text>
            ))}
          </box>
        ) : null}
        <text fg={titleFg}>{indicator}</text>
        <text fg={titleFg}>{props.title}</text>
      </box>
      {isOpen ? (
        <box
          paddingLeft={4}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={theme.color.muted}
        >
          {typeof props.children === "string" ? (
            <text fg={theme.color.mutedForeground}>{props.children}</text>
          ) : (
            props.children
          )}
        </box>
      ) : null}
    </box>
  )
}
