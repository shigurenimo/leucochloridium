import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"
import { usePressable } from "@/tui/components/hooks/hascii/use-pressable"

type Variant = "default" | "outline"

export type Props = {
  variant?: Variant
  placeholder?: string
  value?: string
  width?: number
  isFocused?: boolean
  onInput?: (value: string) => void
  onChange?: (value: string) => void
}

/** Single-line text input. Background (default) or border (outline) cycles rest → hover → pressed → focused. */
export function HasciiInput(props: Props) {
  const variant = props.variant ?? "default"
  const width = props.width ?? 32
  const isFocused = props.isFocused ?? false
  const placeholder = props.placeholder ?? ""

  const theme = useHasciiTheme()
  const press = usePressable()

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
    ? theme.color.mutedForeground
    : isFocused
      ? theme.color.secondaryActive
      : press.isHovered
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
