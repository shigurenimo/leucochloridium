import { useState } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"
import { usePressable } from "@/tui/components/hooks/hascii/use-pressable"

export type Props = {
  isChecked?: boolean
  defaultChecked?: boolean
  isDisabled?: boolean
  onChange?: (next: boolean) => void
}

/** Two-cell on/off switch. The thumb sits at the left or right edge of a 3-cell track. */
export function HasciiSwitch(props: Props) {
  const isDisabled = props.isDisabled ?? false
  const theme = useHasciiTheme()

  const internalState = useState(props.defaultChecked ?? false)
  const internal = internalState[0]
  const setInternal = internalState[1]

  const isChecked = props.isChecked ?? internal

  const toggle = () => {
    const next = !isChecked

    if (props.isChecked === undefined) setInternal(next)
    props.onChange?.(next)
  }

  const press = usePressable({ isDisabled, onPress: toggle })

  const trackBg = isDisabled
    ? theme.color.muted
    : isChecked
      ? press.isPressed
        ? theme.color.primaryActive
        : press.isHovered
          ? theme.color.primaryHover
          : theme.color.primary
      : press.isPressed
        ? theme.color.secondaryActive
        : press.isHovered
          ? theme.color.secondaryActive
          : theme.color.popover

  const thumbFg = isDisabled
    ? theme.color.mutedForeground
    : isChecked
      ? theme.color.primaryForeground
      : theme.color.foreground

  return (
    <box
      width={3}
      height={1}
      backgroundColor={trackBg}
      flexDirection="row"
      alignItems="center"
      justifyContent={isChecked ? "flex-end" : "flex-start"}
      paddingRight={isChecked ? 1 : 0}
      {...press.bind}
    >
      <text fg={thumbFg}>▮</text>
    </box>
  )
}
