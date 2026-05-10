import { createContext, useContext } from "react"
import type { ReactNode } from "react"

export type FormItemContextValue = {
  focusId: string
}

const FormItemContext = createContext<FormItemContextValue | null>(null)

/** Read the surrounding HasciiFormItem context. Returns null when called outside one. */
export function useHasciiFormItem(): FormItemContextValue | null {
  return useContext(FormItemContext)
}

export type Props = {
  value: FormItemContextValue
  children: ReactNode
}

/** Provider used by HasciiFormItem to share the row's focus id with the wrapped HasciiInput. */
export function HasciiFormItemProvider(props: Props) {
  return <FormItemContext.Provider value={props.value}>{props.children}</FormItemContext.Provider>
}
