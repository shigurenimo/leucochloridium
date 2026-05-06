import { createContext, useContext, useState } from "react"
import type { ReactNode } from "react"

type SelectionMode = "single" | "multiple"

type SingleProps = {
  type?: "single"
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
}

type MultipleProps = {
  type: "multiple"
  value?: string[]
  defaultValue?: string[]
  onChange?: (value: string[]) => void
}

export type Props = (SingleProps | MultipleProps) & {
  children?: ReactNode
}

type ContextValue = {
  mode: SelectionMode
  isPressed: (value: string) => boolean
  toggle: (value: string) => void
}

const ToggleGroupContext = createContext<ContextValue | null>(null)

/** Read the current ToggleGroup context. Returns null when called outside a HasciiToggleGroup. */
export function useHasciiToggleGroup(): ContextValue | null {
  return useContext(ToggleGroupContext)
}

const isSingle = (props: Props): props is SingleProps & { children?: ReactNode } =>
  props.type !== "multiple"

/** Segmented row of HasciiToggleGroupItem. type="single" is mutually exclusive; type="multiple" allows any subset. */
export function HasciiToggleGroup(props: Props) {
  const internalSingleState = useState<string>(isSingle(props) ? (props.defaultValue ?? "") : "")
  const internalMultipleState = useState<string[]>(
    !isSingle(props) ? (props.defaultValue ?? []) : [],
  )

  if (isSingle(props)) {
    const internal = internalSingleState[0]
    const setInternal = internalSingleState[1]
    const current = props.value ?? internal

    const toggle = (value: string) => {
      if (props.value === undefined) setInternal(value)
      props.onChange?.(value)
    }

    const ctx: ContextValue = {
      mode: "single",
      isPressed: (value) => value === current,
      toggle,
    }

    return (
      <ToggleGroupContext.Provider value={ctx}>
        <box flexDirection="row" gap={0} height={1}>
          {props.children}
        </box>
      </ToggleGroupContext.Provider>
    )
  }

  const internal = internalMultipleState[0]
  const setInternal = internalMultipleState[1]
  const current = props.value ?? internal

  const toggle = (value: string) => {
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value]
    if (props.value === undefined) setInternal(next)
    props.onChange?.(next)
  }

  const ctx: ContextValue = {
    mode: "multiple",
    isPressed: (value) => current.includes(value),
    toggle,
  }

  return (
    <ToggleGroupContext.Provider value={ctx}>
      <box flexDirection="row" gap={0} height={1}>
        {props.children}
      </box>
    </ToggleGroupContext.Provider>
  )
}
