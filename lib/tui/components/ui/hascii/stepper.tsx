import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type StepperItem = {
  label: string
}

export type Props = {
  steps: StepperItem[]
  current: number
}

/** Horizontal multi-step indicator. Past steps show ■, current shows ▣, future shows □. */
export function HasciiStepper(props: Props) {
  const theme = useHasciiTheme()

  const items: import("react").ReactNode[] = []

  for (let index = 0; index < props.steps.length; index++) {
    const step = props.steps[index]
    if (step === undefined) continue

    const isPast = index < props.current
    const isCurrent = index === props.current

    const markerFg = isPast || isCurrent ? theme.color.primary : theme.color.mutedForeground
    const labelFg = isCurrent ? theme.color.foreground : theme.color.mutedForeground
    const marker = isPast ? "■" : isCurrent ? "▣" : "□"

    items.push(
      <box key={`step-${index}`} flexDirection="row" alignItems="center">
        <text fg={markerFg}>{marker}</text>
        <box paddingLeft={2}>
          <text fg={labelFg}>{step.label}</text>
        </box>
      </box>,
    )

    if (index < props.steps.length - 1) {
      const lineFg = isPast ? theme.color.primary : theme.color.mutedForeground

      items.push(
        <box key={`line-${index}`} paddingLeft={1} paddingRight={1}>
          <text fg={lineFg}>──</text>
        </box>,
      )
    }
  }

  return (
    <box flexDirection="row" alignItems="center">
      {items}
    </box>
  )
}
