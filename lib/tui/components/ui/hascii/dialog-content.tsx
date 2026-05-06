import type { ReactNode } from "react"

export type Props = {
  children?: ReactNode
}

/** Vertical body region inside a HasciiDialog. */
export function HasciiDialogContent(props: Props) {
  return (
    <box flexDirection="column" gap={1}>
      {props.children}
    </box>
  )
}
