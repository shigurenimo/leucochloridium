import { useEffect, useState } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type Props = {
  width?: number
  height?: number
  intervalMs?: number
  cycleMs?: number
}

const lerpChannel = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t)

const parseHex = (hex: string): [number, number, number] => {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return [r, g, b]
}

const toHex = (channel: number): string => channel.toString(16).padStart(2, "0")

const lerpHex = (a: string, b: string, t: number): string => {
  const colorA = parseHex(a)
  const colorB = parseHex(b)
  const r = lerpChannel(colorA[0], colorB[0], t)
  const g = lerpChannel(colorA[1], colorB[1], t)
  const blue = lerpChannel(colorA[2], colorB[2], t)
  return `#${toHex(r)}${toHex(g)}${toHex(blue)}`
}

/** Placeholder block that pulses smoothly between two muted shades using cosine easing. */
export function HasciiSkeleton(props: Props) {
  const intervalMs = props.intervalMs ?? 60
  const cycleMs = props.cycleMs ?? 1800
  const theme = useHasciiTheme()

  const startState = useState<number>(performance.now())
  const start = startState[0]

  const elapsedState = useState(0)
  const elapsed = elapsedState[0]
  const setElapsed = elapsedState[1]

  // useEffect drives the pulse — necessary for time-based color interpolation.
  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(performance.now() - start)
    }, intervalMs)

    return () => clearInterval(id)
  }, [intervalMs, start, setElapsed])

  const phase = ((elapsed % cycleMs) / cycleMs) * 2 * Math.PI
  const t = (1 - Math.cos(phase)) / 2

  const bg = lerpHex(theme.color.muted, theme.color.secondaryActive, t)

  return <box width={props.width} height={props.height ?? 1} backgroundColor={bg} flexShrink={0} />
}
