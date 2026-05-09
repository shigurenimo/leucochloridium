import type { SelectOption } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import type { HasciiTheme } from "@/tui/utils/hascii/theme"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"
import { usePressable } from "@/tui/components/hooks/hascii/use-pressable"

export type Props = {
  options?: SelectOption[]
  width?: number
  height?: number
  defaultIndex?: number
  focusedIndex?: number
  isFocused?: boolean
  onChange?: (index: number, option: SelectOption | null) => void
  onSelect?: (index: number, option: SelectOption | null) => void
}

const pickItemBg = (
  isActive: boolean,
  hovered: boolean,
  pressed: boolean,
  theme: HasciiTheme,
): string | undefined => {
  if (pressed) return theme.color.secondaryActive
  if (hovered && isActive) return theme.color.hoverActive
  if (hovered) return theme.color.secondaryHover
  if (isActive) return theme.color.secondaryActive
  return undefined
}

type ItemProps = {
  option: SelectOption
  isActive: boolean
  onPress: () => void
}

/** Internal row used by HasciiSelect. Tracks hover/press state and renders the active left bar. */
function HasciiSelectItem(props: ItemProps) {
  const theme = useHasciiTheme()
  const press = usePressable({ onPress: props.onPress })

  const bg = pickItemBg(props.isActive, press.isHovered, press.isPressed, theme)

  const nameColor =
    props.isActive || press.isHovered ? theme.color.foreground : theme.color.mutedForeground
  const descColor = theme.color.mutedForeground

  const rowHeight = props.option.description ? 4 : 3

  return (
    <box flexDirection="row" backgroundColor={bg} {...press.bind}>
      {props.isActive ? (
        <box position="absolute" left={0} top={0} bottom={0} flexDirection="column">
          {Array.from({ length: rowHeight }, (_, index) => (
            <text key={index} fg={theme.color.primary}>
              ▏
            </text>
          ))}
        </box>
      ) : null}
      <box
        flexGrow={1}
        flexDirection="column"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        gap={0}
      >
        <text fg={nameColor}>{props.option.name}</text>
        {props.option.description ? <text fg={descColor}>{props.option.description}</text> : null}
      </box>
    </box>
  )
}

/** Vertical option list with a muted background, a flush left bar on the active row, and vertical scrolling when items overflow. */
export function HasciiSelect(props: Props) {
  const width = props.width ?? 36
  const height = props.height ?? 16
  const isFocused = props.isFocused ?? true
  const options = props.options ?? []

  const theme = useHasciiTheme()

  const internalState = useState(props.defaultIndex ?? 0)
  const internal = internalState[0]
  const setInternal = internalState[1]

  const current = props.focusedIndex ?? internal

  const moveTo = (next: number) => {
    if (options.length === 0) return

    const clamped = Math.max(0, Math.min(options.length - 1, next))
    if (props.focusedIndex === undefined) setInternal(clamped)
    props.onChange?.(clamped, options[clamped] ?? null)
  }

  useKeyboard((key) => {
    if (!isFocused || options.length === 0) return

    if (key.name === "up") moveTo(current - 1)
    if (key.name === "down") moveTo(current + 1)
    if (key.name === "return" || key.name === "space") {
      props.onSelect?.(current, options[current] ?? null)
    }
  })

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={theme.color.muted}>
      <scrollbox
        flexGrow={1}
        focused={isFocused}
        scrollY
        stickyScroll={false}
        contentOptions={{ flexDirection: "column", gap: 0 }}
      >
        {options.map((option, index) => (
          <HasciiSelectItem
            key={`${option.value}-${index}`}
            option={option}
            isActive={index === current}
            onPress={() => moveTo(index)}
          />
        ))}
      </scrollbox>
    </box>
  )
}
