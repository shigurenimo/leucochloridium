import type { ReactNode } from "react"

export type Props = {
  children?: ReactNode
}

/** Horizontal action row, right-aligned, at the bottom of a HasciiDialog. */
export function HasciiDialogFooter(props: Props) {
  return (
    <box flexDirection="row" gap={1} justifyContent="flex-end" marginTop={1}>
      {props.children}
    </box>
  )
}
