import { createContext, useContext, useState } from "react"
import type { ReactNode } from "react"

type Mode = "single" | "multiple"

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
  mode: Mode
  isOpen: (value: string) => boolean
  toggle: (value: string) => void
}

const AccordionContext = createContext<ContextValue | null>(null)

/** Read the current Accordion context. Returns null when called outside HasciiAccordion. */
export function useHasciiAccordion(): ContextValue | null {
  return useContext(AccordionContext)
}

const isSingle = (props: Props): props is SingleProps & { children?: ReactNode } =>
  props.type !== "multiple"

/** Vertical stack of collapsible HasciiAccordionItem children. type="single" only opens one section at a time. */
export function HasciiAccordion(props: Props) {
  const internalSingleState = useState<string>(isSingle(props) ? (props.defaultValue ?? "") : "")
  const internalMultipleState = useState<string[]>(
    !isSingle(props) ? (props.defaultValue ?? []) : [],
  )

  if (isSingle(props)) {
    const internal = internalSingleState[0]
    const setInternal = internalSingleState[1]
    const current = props.value ?? internal

    const toggle = (value: string) => {
      const next = current === value ? "" : value

      if (props.value === undefined) setInternal(next)
      props.onChange?.(next)
    }

    const ctx: ContextValue = {
      mode: "single",
      isOpen: (value) => value === current,
      toggle,
    }

    return (
      <AccordionContext.Provider value={ctx}>
        <box flexDirection="column">{props.children}</box>
      </AccordionContext.Provider>
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
    isOpen: (value) => current.includes(value),
    toggle,
  }

  return (
    <AccordionContext.Provider value={ctx}>
      <box flexDirection="column">{props.children}</box>
    </AccordionContext.Provider>
  )
}
