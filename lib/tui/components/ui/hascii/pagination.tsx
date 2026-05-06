import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"
import { usePressable } from "@/tui/components/hooks/hascii/use-pressable"

export type Props = {
  page: number
  pageCount: number
  onChange?: (page: number) => void
}

type ButtonProps = {
  label: string
  isActive?: boolean
  isDisabled?: boolean
  onPress: () => void
}

function PageButton(props: ButtonProps) {
  const theme = useHasciiTheme()
  const press = usePressable({
    isDisabled: props.isDisabled,
    onPress: props.onPress,
  })

  const fg = props.isDisabled
    ? theme.color.mutedForeground
    : props.isActive
      ? theme.color.primaryForeground
      : theme.color.foreground

  const bg = props.isDisabled
    ? undefined
    : props.isActive
      ? theme.color.primary
      : press.isPressed
        ? theme.color.accentActive
        : press.isHovered
          ? theme.color.accentHover
          : undefined

  return (
    <box paddingLeft={1} paddingRight={1} height={1} backgroundColor={bg} {...press.bind}>
      <text fg={fg}>{props.label}</text>
    </box>
  )
}

export const buildPageList = (page: number, pageCount: number): (number | null)[] => {
  if (pageCount <= 7) {
    const list: number[] = []
    for (let index = 1; index <= pageCount; index++) list.push(index)
    return list
  }

  const result: (number | null)[] = [1]
  const left = Math.max(2, page - 1)
  const right = Math.min(pageCount - 1, page + 1)

  if (left > 2) result.push(null)
  for (let index = left; index <= right; index++) result.push(index)
  if (right < pageCount - 1) result.push(null)

  result.push(pageCount)
  return result
}

/** Page navigator with previous, next, and numeric jumps. Renders ellipses when collapsed. */
export function HasciiPagination(props: Props) {
  const theme = useHasciiTheme()

  const change = (next: number) => {
    if (next < 1 || next > props.pageCount || next === props.page) return
    props.onChange?.(next)
  }

  const pages = buildPageList(props.page, props.pageCount)

  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <PageButton label="<" isDisabled={props.page <= 1} onPress={() => change(props.page - 1)} />
      {pages.map((entry, index) => {
        if (entry === null) {
          return (
            <box key={`gap-${index}`} paddingLeft={1} paddingRight={1}>
              <text fg={theme.color.mutedForeground}>…</text>
            </box>
          )
        }

        return (
          <PageButton
            key={entry}
            label={String(entry)}
            isActive={entry === props.page}
            onPress={() => change(entry)}
          />
        )
      })}
      <PageButton
        label=">"
        isDisabled={props.page >= props.pageCount}
        onPress={() => change(props.page + 1)}
      />
    </box>
  )
}
