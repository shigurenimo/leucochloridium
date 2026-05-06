import { useKeyboard } from "@opentui/react"
import { createContext, useContext, useState } from "react"
import type { ReactNode } from "react"

type ContextValue = {
  currentId: string | null
  setCurrentId: (id: string) => void
}

const HasciiFocusContext = createContext<ContextValue | null>(null)

/** Returns whether the provided focusId matches the surrounding HasciiFocusGroup's current focus. */
export function useHasciiFocus(focusId: string | undefined): boolean {
  const ctx = useContext(HasciiFocusContext)

  if (!ctx || focusId === undefined) return false
  return ctx.currentId === focusId
}

/** Returns the imperative API of the surrounding HasciiFocusGroup. Null when used outside a group. */
export function useHasciiFocusController(): ContextValue | null {
  return useContext(HasciiFocusContext)
}

/** Computes the next focus index. Wraps at both ends. */
export function nextFocusIndex(currentIndex: number, length: number, isShift: boolean): number {
  if (length === 0) return -1

  return isShift ? (currentIndex - 1 + length) % length : (currentIndex + 1) % length
}

export type Props = {
  ids: readonly string[]
  defaultId?: string
  children: ReactNode
}

/** Manages keyboard focus across an ordered list of children. Tab cycles forward; Shift+Tab cycles back. */
export function HasciiFocusGroup(props: Props) {
  const initialId = props.defaultId ?? props.ids[0] ?? null

  const currentState = useState<string | null>(initialId)
  const currentId = currentState[0]
  const setCurrentId = currentState[1]

  useKeyboard((key) => {
    if (key.name !== "tab" || props.ids.length === 0) return

    const currentIndex = currentId ? props.ids.indexOf(currentId) : -1
    const next = nextFocusIndex(currentIndex, props.ids.length, key.shift ?? false)

    const target = props.ids[next]
    if (target !== undefined) setCurrentId(target)
  })

  const value: ContextValue = {
    currentId,
    setCurrentId: (id: string) => setCurrentId(id),
  }

  return <HasciiFocusContext.Provider value={value}>{props.children}</HasciiFocusContext.Provider>
}
