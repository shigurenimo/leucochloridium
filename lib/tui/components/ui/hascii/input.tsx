import { useKeyboard } from "@opentui/react"
import { useId, useState } from "react"
import { useHasciiInputFocus } from "@/tui/utils/hascii/input-focus-context"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"
import { usePressable } from "@/tui/components/hooks/hascii/use-pressable"

type Variant = "default" | "outline"

export type Props = {
  variant?: Variant
  placeholder?: string
  value?: string
  width?: number
  defaultFocused?: boolean
  onInput?: (value: string) => void
  onChange?: (value: string) => void
}

/** Single-line text input. Click to focus, Esc / outside click to blur (requires HasciiInputFocusProvider for outside click). */
export function HasciiInput(props: Props) {
  const variant = props.variant ?? "default"
  const width = props.width ?? 32
  const placeholder = props.placeholder ?? ""

  const id = useId()
  const focusCtx = useHasciiInputFocus()
  const fallbackState = useState(props.defaultFocused ?? false)
  const isFocused = focusCtx ? focusCtx.focusedId === id : fallbackState[0]

  const focus = (): void => {
    if (focusCtx) focusCtx.setFocusedId(id)
    else fallbackState[1](true)
  }

  const blur = (): void => {
    if (focusCtx) focusCtx.setFocusedId(null)
    else fallbackState[1](false)
  }

  const theme = useHasciiTheme()
  const press = usePressable()

  useKeyboard((key) => {
    if (!isFocused) return
    if (key.name === "escape") blur()
  })

  if (variant === "outline") {
    const borderColor = press.isPressed
      ? theme.color.foreground
      : isFocused
        ? theme.color.ring
        : press.isHovered
          ? theme.color.mutedForeground
          : theme.color.input

    return (
      <box
        border
        borderStyle="rounded"
        borderColor={borderColor}
        height={3}
        width={width}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.color.background}
        justifyContent="center"
        {...press.bind}
        onMouseDown={(event) => {
          event.stopPropagation()
          press.bind.onMouseDown()
          focus()
        }}
      >
        <input
          focused={isFocused}
          placeholder={placeholder}
          value={props.value}
          textColor={theme.color.foreground}
          placeholderColor={theme.color.mutedForeground}
          cursorColor={theme.color.foreground}
          onInput={props.onInput}
          onChange={props.onChange}
        />
      </box>
    )
  }

  const bg = press.isPressed
    ? theme.color.secondaryActive
    : isFocused || press.isHovered
      ? theme.color.secondaryHover
      : theme.color.muted

  return (
    <box
      height={3}
      width={width}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={bg}
      justifyContent="center"
      {...press.bind}
      onMouseDown={(event) => {
        event.stopPropagation()
        press.bind.onMouseDown()
        focus()
      }}
    >
      <input
        focused={isFocused}
        placeholder={placeholder}
        value={props.value}
        textColor={theme.color.foreground}
        placeholderColor={theme.color.mutedForeground}
        cursorColor={theme.color.foreground}
        onInput={props.onInput}
        onChange={props.onChange}
      />
      {isFocused ? (
        <box position="absolute" bottom={0} left={0} right={0}>
          <text fg={theme.color.primary}>{"▁".repeat(width)}</text>
        </box>
      ) : null}
    </box>
  )
}
