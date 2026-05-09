import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"
import { usePressable } from "@/tui/components/hooks/hascii/use-pressable"
import { HasciiInput } from "@/tui/components/ui/hascii/input"

export type CommandItem = {
  id: string
  label: string
  hint?: string
}

export type Props = {
  items: CommandItem[]
  placeholder?: string
  width?: number
  maxRows?: number
  isFocused?: boolean
  onRun?: (id: string) => void
}

type RowProps = {
  item: CommandItem
  isActive: boolean
  onHover: () => void
  onPress: () => void
}

const ROW_HEIGHT = 1

/** Internal row used by HasciiCommand. Hover moves the active cursor; only the active row gets a bg + ▏ left rule. */
function HasciiCommandRow(props: RowProps) {
  const theme = useHasciiTheme()
  const press = usePressable({ onPress: props.onPress })

  const bg = props.isActive ? theme.color.secondaryActive : undefined

  return (
    <box
      flexDirection="row"
      alignItems="center"
      justifyContent="space-between"
      paddingLeft={2}
      paddingRight={2}
      height={ROW_HEIGHT}
      backgroundColor={bg}
      onMouseOver={() => {
        press.bind.onMouseOver()
        props.onHover()
      }}
      onMouseOut={press.bind.onMouseOut}
      onMouseDown={press.bind.onMouseDown}
      onMouseUp={press.bind.onMouseUp}
    >
      {props.isActive ? (
        <box position="absolute" left={0} top={0} bottom={0} flexDirection="column">
          {Array.from({ length: ROW_HEIGHT }, (_, index) => (
            <text key={index} fg={theme.color.primary}>
              ▏
            </text>
          ))}
        </box>
      ) : null}
      <text fg={theme.color.foreground}>{props.item.label}</text>
      {props.item.hint !== undefined ? (
        <text fg={theme.color.mutedForeground}>{props.item.hint}</text>
      ) : null}
    </box>
  )
}

const matches = (item: CommandItem, query: string): boolean => {
  if (query.length === 0) return true

  const needle = query.toLowerCase()
  return item.label.toLowerCase().includes(needle)
}

/** Keyboard-driven palette: type to filter, ↑/↓ moves the cursor (also moved by hover), Enter runs. The input bar is HasciiInput. */
export function HasciiCommand(props: Props) {
  const width = props.width ?? 48
  const maxRows = props.maxRows ?? 8
  const isFocused = props.isFocused ?? true
  const placeholder = props.placeholder ?? "type a command…"
  const theme = useHasciiTheme()

  const queryState = useState("")
  const query = queryState[0]
  const setQuery = queryState[1]

  const indexState = useState(0)
  const activeIndex = indexState[0]
  const setActiveIndex = indexState[1]

  const filtered = props.items.filter((item) => matches(item, query))
  const safeIndex = filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1)

  useKeyboard((key) => {
    if (!isFocused) return

    if (key.name === "up") {
      setActiveIndex(Math.max(0, safeIndex - 1))
      return
    }

    if (key.name === "down") {
      setActiveIndex(Math.min(filtered.length - 1, safeIndex + 1))
      return
    }

    if (key.name === "return") {
      const item = filtered[safeIndex]
      if (item) props.onRun?.(item.id)
      return
    }
  })

  return (
    <box width={width} backgroundColor={theme.color.card} flexDirection="column">
      <HasciiInput
        defaultFocused={isFocused}
        width={width}
        value={query}
        placeholder={placeholder}
        onInput={(value) => {
          setQuery(value)
          setActiveIndex(0)
        }}
      />
      <box height={maxRows}>
        {filtered.length === 0 ? (
          <box paddingLeft={2} paddingRight={2} height={1}>
            <text fg={theme.color.mutedForeground}>no matches</text>
          </box>
        ) : (
          <scrollbox
            flexGrow={1}
            scrollY
            stickyScroll={false}
            contentOptions={{ flexDirection: "column", gap: 0 }}
          >
            {filtered.map((item, index) => (
              <HasciiCommandRow
                key={item.id}
                item={item}
                isActive={index === safeIndex}
                onHover={() => setActiveIndex(index)}
                onPress={() => {
                  setActiveIndex(index)
                  props.onRun?.(item.id)
                }}
              />
            ))}
          </scrollbox>
        )}
      </box>
    </box>
  )
}
