import { createContext, useContext, useState } from "react"
import type { ReactNode } from "react"

type ContextValue = {
  focusedId: string | null
  setFocusedId: (id: string | null) => void
}

const InputFocusContext = createContext<ContextValue | null>(null)

/** Returns the surrounding HasciiInputFocusProvider's API. Null when no provider is mounted. */
export function useHasciiInputFocus(): ContextValue | null {
  return useContext(InputFocusContext)
}

export type Props = {
  children: ReactNode
}

/** Holds the id of the currently focused HasciiInput so siblings and outer click handlers can blur it. */
export function HasciiInputFocusProvider(props: Props) {
  const focusedState = useState<string | null>(null)

  const value: ContextValue = {
    focusedId: focusedState[0],
    setFocusedId: focusedState[1],
  }

  return <InputFocusContext.Provider value={value}>{props.children}</InputFocusContext.Provider>
}
