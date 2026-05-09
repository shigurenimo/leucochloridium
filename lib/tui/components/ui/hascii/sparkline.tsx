import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type Props = {
  values: number[]
  width?: number
  color?: string
}

const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/** Single-row Unicode bar chart. Maps each value to one of eight block heights. */
export function HasciiSparkline(props: Props) {
  const theme = useHasciiTheme()
  const color = props.color ?? theme.color.primary

  const samples = props.width !== undefined ? takeSamples(props.values, props.width) : props.values

  if (samples.length === 0) {
    return <text fg={color}> </text>
  }

  let min = Infinity
  let max = -Infinity

  for (const value of samples) {
    if (value < min) min = value
    if (value > max) max = value
  }

  const range = max - min || 1

  const glyphs = samples.map((value) => {
    const ratio = (value - min) / range
    const index = Math.min(BARS.length - 1, Math.round(ratio * (BARS.length - 1)))
    return BARS[index]
  })

  return <text fg={color}>{glyphs.join("")}</text>
}

const takeSamples = (values: number[], targetWidth: number): number[] => {
  if (values.length <= targetWidth) return values

  const samples: number[] = []
  const stride = values.length / targetWidth

  for (let index = 0; index < targetWidth; index++) {
    const sourceIndex = Math.min(values.length - 1, Math.floor(index * stride))
    samples.push(values[sourceIndex] ?? 0)
  }

  return samples
}
