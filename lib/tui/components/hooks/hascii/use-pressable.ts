import { useState } from "react"

export type Bindings = {
  onMouseOver: () => void
  onMouseOut: () => void
  onMouseDown: () => void
  onMouseUp: () => void
}

export type PressableState = {
  isHovered: boolean
  isPressed: boolean
  bind: Bindings
}

export type Options = {
  isDisabled?: boolean
  onPress?: () => void
}

/** Tracks hover and press state for a focusable element and exposes mouse handlers ready for spread. */
export function usePressable(options?: Options): PressableState {
  const isDisabled = options?.isDisabled ?? false
  const onPress = options?.onPress

  const hoveredState = useState(false)
  const isHovered = hoveredState[0]
  const setHovered = hoveredState[1]

  const pressedState = useState(false)
  const isPressed = pressedState[0]
  const setPressed = pressedState[1]

  const bind: Bindings = {
    onMouseOver: () => {
      if (!isDisabled) setHovered(true)
    },
    onMouseOut: () => {
      setHovered(false)
      setPressed(false)
    },
    onMouseDown: () => {
      if (!isDisabled) setPressed(true)
    },
    onMouseUp: () => {
      if (isDisabled) return

      if (isPressed) onPress?.()
      setPressed(false)
    },
  }

  return { isHovered, isPressed, bind }
}
