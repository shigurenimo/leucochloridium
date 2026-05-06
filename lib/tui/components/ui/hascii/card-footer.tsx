import type { ReactNode } from "react"

export type Props = {
  children?: ReactNode
}

/** Horizontal footer region for action rows inside a HasciiCard. */
export function HasciiCardFooter(props: Props) {
  return (
    <box flexDirection="row" justifyContent="flex-end" gap={1}>
      {props.children}
    </box>
  )
}
