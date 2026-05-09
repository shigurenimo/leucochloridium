import { RGBA, SliderRenderable } from "@opentui/core"
import { extend } from "@opentui/react"
import { useState } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

declare module "@opentui/react" {
  interface OpenTUIComponents {
    slider: typeof SliderRenderable
  }
}

extend({ slider: SliderRenderable })

export type Props = {
  value?: number
  defaultValue?: number
  min?: number
  max?: number
  width?: number
  thumbSize?: number
  onChange?: (next: number) => void
}

const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)

const viewPortSizeFor = (thumbCells: number, range: number, width: number): number => {
  const virtualThumb = thumbCells * 2
  const denominator = width * 2 - virtualThumb

  if (denominator <= 0) return range

  return Math.max(1, Math.round((virtualThumb * range) / denominator))
}

/** Horizontal slider backed by OpenTUI's SliderRenderable. A ─ track sits behind a thumbSize-cell thumb that supports native click + drag. */
export function HasciiSlider(props: Props) {
  const min = props.min ?? 0
  const max = props.max ?? 100
  const width = props.width ?? 32
  const thumbSize = props.thumbSize ?? 3

  const theme = useHasciiTheme()

  const internalState = useState(props.defaultValue ?? min)
  const internal = internalState[0]
  const setInternal = internalState[1]

  const value = props.value ?? internal

  const onChange = (next: number) => {
    if (props.value === undefined) setInternal(next)
    props.onChange?.(next)
  }

  const hoveredState = useState(false)
  const isHovered = hoveredState[0]
  const setHovered = hoveredState[1]

  const range = Math.max(1, max - min)
  const viewPortSize = viewPortSizeFor(thumbSize, range, width)

  const thumbFg = isHovered ? theme.color.primaryHover : theme.color.primary

  return (
    <box
      width={width}
      height={1}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <box position="absolute" left={0} top={0}>
        <text fg={theme.color.border}>{"─".repeat(width)}</text>
      </box>
      <slider
        position="absolute"
        left={0}
        top={0}
        orientation="horizontal"
        width={width}
        height={1}
        min={min}
        max={max}
        value={value}
        viewPortSize={viewPortSize}
        foregroundColor={thumbFg}
        backgroundColor={TRANSPARENT}
        onChange={onChange}
      />
    </box>
  )
}
