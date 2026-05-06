import type { ReactNode } from "react"

export type Props = {
  isFocused?: boolean
  children?: ReactNode
}

/** Scrollable middle region of a HasciiSidebar. Wheel + arrow keys scroll vertically. */
export function HasciiSidebarContent(props: Props) {
  const isFocused = props.isFocused ?? true

  return (
    <scrollbox
      flexGrow={1}
      focused={isFocused}
      scrollY
      stickyScroll={false}
      contentOptions={{ flexDirection: "column", gap: 0 }}
    >
      {props.children}
    </scrollbox>
  )
}
