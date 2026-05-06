import { createContext, useContext } from "react"
import type { ReactNode } from "react"
import type { HasciiTheme } from "@/tui/utils/hascii/theme"
import { hasciiTheme } from "@/tui/utils/hascii/theme"

const HasciiThemeContext = createContext<HasciiTheme>(hasciiTheme)

/** Read the active theme from context. Falls back to the default theme outside a provider. */
export function useHasciiTheme(): HasciiTheme {
  return useContext(HasciiThemeContext)
}

export type Props = {
  theme?: HasciiTheme
  children: ReactNode
}

/** Wraps a subtree with a HasciiTheme so descendants can read tokens via useHasciiTheme. */
export function HasciiThemeProvider(props: Props) {
  return (
    <HasciiThemeContext.Provider value={props.theme ?? hasciiTheme}>
      {props.children}
    </HasciiThemeContext.Provider>
  )
}
