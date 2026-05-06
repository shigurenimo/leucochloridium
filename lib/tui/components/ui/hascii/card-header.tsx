import type { ReactNode } from "react"

export type Props = {
  children?: ReactNode
}

/** Vertical heading group typically holding HasciiCardTitle and HasciiCardDescription. */
export function HasciiCardHeader(props: Props) {
  return (
    <box flexDirection="column" gap={0}>
      {props.children}
    </box>
  )
}
