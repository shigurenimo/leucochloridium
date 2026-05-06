import type { ReactNode } from "react"

export type Props = {
  children?: ReactNode
}

/** Top section of a HasciiSidebar. Renders children at the sidebar's text padding. */
export function HasciiSidebarHeader(props: Props) {
  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={0}>
      {props.children}
    </box>
  )
}
