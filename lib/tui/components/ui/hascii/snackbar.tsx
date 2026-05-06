import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

type Variant = "default" | "secondary" | "destructive"

export type Props = {
  variant?: Variant
  width?: number
  slideMs?: number
  isOpen?: boolean
  children?: ReactNode
}

/** Toast-like overlay that slides in from the right edge. Render inside an end-aligned column to anchor bottom-right. */
export function HasciiSnackbar(props: Props) {
  const variant = props.variant ?? "default"
  const width = props.width ?? 28
  const slideMs = props.slideMs ?? 90
  const isOpen = props.isOpen ?? true

  const theme = useHasciiTheme()

  const offsetState = useState(width)
  const offset = offsetState[0]
  const setOffset = offsetState[1]

  // useEffect drives the slide animation by stepping marginRight from `width` to 0 (or back).
  useEffect(() => {
    const target = isOpen ? 0 : width
    if (offset === target) return

    const start = performance.now()
    const from = offset
    let frame = 0

    const tick = () => {
      const progress = Math.min(1, (performance.now() - start) / slideMs)
      const next = Math.round(from + (target - from) * progress)
      setOffset(next)

      if (progress < 1) {
        frame = setTimeout(tick, 16) as unknown as number
      }
    }

    tick()

    return () => clearTimeout(frame)
  }, [isOpen, width, slideMs, offset, setOffset])

  const palette = {
    default: { bg: theme.color.primary, fg: theme.color.primaryForeground },
    secondary: { bg: theme.color.secondary, fg: theme.color.secondaryForeground },
    destructive: {
      bg: theme.color.destructive,
      fg: theme.color.destructiveForeground,
    },
  }[variant]

  return (
    <box
      flexDirection="row"
      width={width}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      marginRight={-offset}
      backgroundColor={palette.bg}
    >
      <text fg={palette.fg}>{props.children}</text>
    </box>
  )
}
