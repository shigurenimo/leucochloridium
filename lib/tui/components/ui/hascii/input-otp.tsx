import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type Props = {
  length?: number
  value?: string
  defaultValue?: string
  isFocused?: boolean
  onChange?: (value: string) => void
  onComplete?: (value: string) => void
}

const isDigit = (key: string): boolean => /^[0-9]$/.test(key)

/** OTP slot row. Uncontrolled by default — type digits to fill, backspace to erase. */
export function HasciiInputOtp(props: Props) {
  const length = props.length ?? 6
  const isFocused = props.isFocused ?? true
  const theme = useHasciiTheme()

  const internalState = useState(props.defaultValue ?? "")
  const internal = internalState[0]
  const setInternal = internalState[1]

  const value = props.value ?? internal

  const setValue = (next: string) => {
    if (props.value === undefined) setInternal(next)
    props.onChange?.(next)

    if (next.length === length) props.onComplete?.(next)
  }

  useKeyboard((key) => {
    if (!isFocused) return

    if (key.name === "backspace") {
      if (value.length > 0) setValue(value.slice(0, -1))
      return
    }

    if (isDigit(key.name) && value.length < length) {
      setValue(value + key.name)
    }
  })

  const slots: number[] = []
  for (let index = 0; index < length; index++) slots.push(index)

  const focusedIndex = Math.min(value.length, length - 1)

  return (
    <box flexDirection="row" gap={1}>
      {slots.map((index) => {
        const char = value[index]
        const isSlotFocused = isFocused && index === focusedIndex
        const isFilled = char !== undefined

        const borderColor = isSlotFocused
          ? theme.color.ring
          : isFilled
            ? theme.color.border
            : theme.color.input

        return (
          <box
            key={index}
            border
            borderStyle="rounded"
            borderColor={borderColor}
            backgroundColor={theme.color.background}
            width={5}
            height={3}
            alignItems="center"
            justifyContent="center"
          >
            <text fg={isFilled ? theme.color.foreground : theme.color.mutedForeground}>
              {char ?? "·"}
            </text>
          </box>
        )
      })}
    </box>
  )
}
