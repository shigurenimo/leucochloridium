import type { ReactNode } from "react"

export type Props = {
  children?: ReactNode
}

/** Vertical content region inside a HasciiCard. paddingY=1 keeps the body separated from neighbouring header and footer. */
export function HasciiCardContent(props: Props) {
  return (
    <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
      {props.children}
    </box>
  )
}
