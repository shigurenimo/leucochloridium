import type { ReactNode } from "react"

export type Props = {
  children?: ReactNode
}

/** Dialog header. Stacks the children vertically with the standard 1-cell gap. */
export function HasciiDialogHeader(props: Props) {
  return (
    <box flexDirection="column" gap={1}>
      {props.children}
    </box>
  )
}
