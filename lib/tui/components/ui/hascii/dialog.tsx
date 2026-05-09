import type { ReactNode } from "react"
import { HasciiButton } from "@/tui/components/ui/hascii/button"
import { HasciiCard } from "@/tui/components/ui/hascii/card"

export type Props = {
  width?: number
  onClose?: () => void
  children?: ReactNode
}

/** Floating dialog. Wraps a HasciiCard for layout and renders a default-variant x button just above the card's top-right corner when onClose is provided. */
export function HasciiDialog(props: Props) {
  const width = props.width ?? 48

  return (
    <box width={width} paddingTop={1}>
      <HasciiCard width={width}>{props.children}</HasciiCard>
      {props.onClose ? (
        <box position="absolute" top={0} right={0}>
          <HasciiButton variant="secondary" size="default" onPress={props.onClose}>
            x
          </HasciiButton>
        </box>
      ) : null}
    </box>
  )
}
