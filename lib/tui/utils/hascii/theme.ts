import { hasciiTw } from "@/tui/utils/hascii/tw-token"

export type HasciiTheme = {
  color: {
    background: string
    foreground: string

    primary: string
    primaryForeground: string
    primaryHover: string
    primaryActive: string

    secondary: string
    secondaryForeground: string
    secondaryHover: string
    secondaryActive: string

    muted: string
    mutedForeground: string

    accent: string
    accentForeground: string
    accentHover: string
    accentActive: string

    destructive: string
    destructiveForeground: string
    destructiveHover: string
    destructiveActive: string

    border: string
    input: string
    ring: string
  }
}

/** Default dark theme. Mirrors shadcn naming and is built from the Tailwind palette. */
export const hasciiTheme: HasciiTheme = {
  color: {
    background: hasciiTw.colors.zinc[950],
    foreground: hasciiTw.colors.zinc[50],

    primary: hasciiTw.colors.zinc[50],
    primaryForeground: hasciiTw.colors.zinc[950],
    primaryHover: hasciiTw.colors.zinc[200],
    primaryActive: hasciiTw.colors.zinc[400],

    secondary: hasciiTw.colors.zinc[800],
    secondaryForeground: hasciiTw.colors.zinc[50],
    secondaryHover: hasciiTw.colors.zinc[700],
    secondaryActive: hasciiTw.colors.zinc[600],

    muted: hasciiTw.colors.zinc[800],
    mutedForeground: hasciiTw.colors.zinc[400],

    accent: hasciiTw.colors.zinc[800],
    accentForeground: hasciiTw.colors.zinc[50],
    accentHover: hasciiTw.colors.zinc[900],
    accentActive: hasciiTw.colors.zinc[700],

    destructive: hasciiTw.colors.red[900],
    destructiveForeground: hasciiTw.colors.red[50],
    destructiveHover: hasciiTw.colors.red[800],
    destructiveActive: hasciiTw.colors.red[700],

    border: hasciiTw.colors.zinc[700],
    input: hasciiTw.colors.zinc[700],
    ring: hasciiTw.colors.zinc[300],
  },
}
