import { HasciiButton } from "@/tui/components/ui/hascii/button"
import { HasciiDialog } from "@/tui/components/ui/hascii/dialog"
import { HasciiDialogDescription } from "@/tui/components/ui/hascii/dialog-description"
import { HasciiDialogFooter } from "@/tui/components/ui/hascii/dialog-footer"
import { HasciiDialogHeader } from "@/tui/components/ui/hascii/dialog-header"
import { HasciiDialogTitle } from "@/tui/components/ui/hascii/dialog-title"

export type Props = {
  title: string
  description?: string
  okText?: string
  cancelText?: string
  width?: number
  onOk?: () => void
  onCancel?: () => void
  onClose?: () => void
}

/** Convenience wrapper around HasciiDialog. Renders a title, optional description, and one or two footer buttons (OK / optional Cancel). */
export function HasciiAlertDialog(props: Props) {
  const okText = props.okText ?? "OK"

  return (
    <HasciiDialog width={props.width} onClose={props.onClose}>
      <HasciiDialogHeader>
        <HasciiDialogTitle>{props.title}</HasciiDialogTitle>
        {props.description !== undefined ? (
          <HasciiDialogDescription>{props.description}</HasciiDialogDescription>
        ) : null}
      </HasciiDialogHeader>
      <HasciiDialogFooter>
        {props.cancelText !== undefined ? (
          <HasciiButton variant="secondary" size="default" onPress={props.onCancel}>
            {props.cancelText}
          </HasciiButton>
        ) : null}
        <HasciiButton variant="default" size="default" onPress={props.onOk}>
          {okText}
        </HasciiButton>
      </HasciiDialogFooter>
    </HasciiDialog>
  )
}
