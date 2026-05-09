import type { ReactNode } from "react"
import { useState } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"
import { usePressable } from "@/tui/components/hooks/hascii/use-pressable"

type Type = "ballot" | "square"

export type Props = {
  type?: Type
  isChecked?: boolean
  defaultChecked?: boolean
  isDisabled?: boolean
  onChange?: (next: boolean) => void
  children?: ReactNode
}

const GLYPHS: Record<Type, { checked: string; unchecked: string }> = {
  ballot: { checked: "☑", unchecked: "☐" },
  square: { checked: "■", unchecked: "□" },
}

/** Single checkbox row. type="ballot" (default) uses ☐/☑; type="square" matches the stepper's ■/□ glyphs. */
export function HasciiCheckbox(props: Props) {
  const type = props.type ?? "ballot"
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

  const glyphFg = isDisabled
    ? theme.color.mutedForeground
    : isChecked
      ? theme.color.primary
      : press.isHovered
        ? theme.color.foreground
        : theme.color.mutedForeground

  const labelFg = isDisabled ? theme.color.mutedForeground : theme.color.foreground

  const glyphs = GLYPHS[type]

  return (
    <box flexDirection="row" alignItems="center" {...press.bind}>
      <text fg={glyphFg}>{isChecked ? glyphs.checked : glyphs.unchecked}</text>
      {props.children !== undefined ? (
        <box paddingLeft={2}>
          <text fg={labelFg}>{props.children}</text>
        </box>
      ) : null}
    </box>
  )
}
