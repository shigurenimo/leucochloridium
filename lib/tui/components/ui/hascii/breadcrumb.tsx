import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type BreadcrumbItem = {
  label: string
  value?: string
}

export type Props = {
  items: BreadcrumbItem[]
  separator?: string
  onSelect?: (value: string) => void
}

/** Horizontal trail of crumbs joined by a separator. The last item is rendered as the current location. */
export function HasciiBreadcrumb(props: Props) {
  const separator = props.separator ?? "›"
  const theme = useHasciiTheme()

  const cells: { id: string; node: import("react").ReactNode }[] = []

  for (let index = 0; index < props.items.length; index++) {
    const item = props.items[index]
    if (item === undefined) continue

    const isLast = index === props.items.length - 1
    const fg = isLast ? theme.color.foreground : theme.color.mutedForeground
    const onPress = isLast || item.value === undefined ? undefined : () => props.onSelect?.(item.value as string)

    cells.push({
      id: `crumb-${index}`,
      node: (
        <box paddingLeft={0} paddingRight={0} onMouseUp={onPress}>
          <text fg={fg}>{item.label}</text>
        </box>
      ),
    })

    if (!isLast) {
      cells.push({
        id: `sep-${index}`,
        node: (
          <box paddingLeft={1} paddingRight={1}>
            <text fg={theme.color.mutedForeground}>{separator}</text>
          </box>
        ),
      })
    }
  }

  return (
    <box flexDirection="row" alignItems="center">
      {cells.map((cell) => (
        <box key={cell.id}>{cell.node}</box>
      ))}
    </box>
  )
}
